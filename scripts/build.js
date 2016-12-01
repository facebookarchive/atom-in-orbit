'use strict'

const JS_FILE_HEADER = `\
/*
Copyright (c) 2016-present, Facebook, Inc. All rights reserved.

The examples provided by Facebook are for non-commercial testing and evaluation
purposes only. Facebook reserves all rights not expressly granted.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
FACEBOOK BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
`;

const config = require('./config');
if (config.ATOM_SRC == null) {
  throw Error('Must specify ATOM_SRC in config.local.json');
}
const path = require('path');
const ATOM_SRC = path.normalize(config.ATOM_SRC);

// TODO(mbolin): Run `yarn check || yarn --force` in root?
const root = path.normalize(path.join(__dirname, '..'));

// As of Atom f7d3f0210bf6ff1b4193d8a8b8a54c199b561bc2, we need to apply some
// patches to Atom to get this prototype to work.

const fs = require('fs-plus');
// All of our generated files will be written to this directory.
const outDir = root + '/out';
makeCleanDir(outDir);

// This is our clone of the Atom directory that we hack up for our needs.
// Note that Atom should have already been built in ATOM_SRC when this script is
// run so we pick up all of its node_modules.
const atomDir = outDir + '/atom';
makeCleanDir(atomDir);

const {execFileSync, spawnSync} = require('child_process');

// These executions of `patch` are really bad because they leave ATOM_SRC in a modified state, so we
// really need to do better than this. The real solution is to upstream the appropriate fixes such
// that these patches are unnecessary.

// This is fixed in Atom master as of 089fa92117f5d0ead54b56ee208a2baa24d9c4e2.
execFileSync('patch', [
  path.join(ATOM_SRC, 'src/atom-environment.coffee'),
  path.join(root, 'scripts/patches/src/atom-environment.coffee.patch'),
]);

// Custom change so we can export the functions that we need from compile-cache.
execFileSync('patch', [
  path.join(ATOM_SRC, 'src/compile-cache.js'),
  path.join(root, 'scripts/patches/src/compile-cache.js.patch'),
]);
const {COMPILERS, compileFileAtPath, setAtomHomeDirectory} = require(
  path.join(ATOM_SRC, 'src/compile-cache'));

const browserify = require('browserify');
const chokidar = require('chokidar');
const through = require('through');
const watchify = require('watchify');

const willWatch = process.argv[2] == '-w'; // poor man's arg parsing.
let startedWatching = false;

function build() {
  // This is necessary to set the compile-cache.
  setAtomHomeDirectory(path.join(fs.getHomeDirectory(), '.atom'));

  copyFileSyncWatch(ATOM_SRC + '/package.json', atomDir + '/package.json');

  // When we copy src/ and exports/, we must also transpile everything inside.
  copySyncWatch(
    ATOM_SRC + '/src',
    atomDir + '/src',
    tree => fs.traverseTreeSync(tree, transpileFile, () => true)
  );
  copySyncWatch(
    ATOM_SRC + '/exports',
    atomDir + '/exports',
    tree => fs.traverseTreeSync(tree, transpileFile, () => true)
  );
  copySyncWatch(
    ATOM_SRC + '/static',
    atomDir + '/static',
    tree => {}
  );
  copySyncWatch(
    ATOM_SRC + '/node_modules',
    atomDir + '/node_modules',
    tree => {}
  );
  copyFileSyncWatch(ATOM_SRC + '/static/octicons.woff', outDir + '/octicons.woff');

  // All built-in Atom packages that are installed under node_modules/ in
  // ATOM_SRC because Atom's own build script has special handling for the
  // "packageDependencies" section in its package.json file. I am pretty sure
  // that something bad would happen if they had a transitive dependency on a
  // Node module with the same name as one of their built-in Atom packages.
  const atomPackages = [
    // To include an Atom package in the prototype, add it to this list. Its
    // code must exist under node_modules. Even though these are Atom packages,
    // installing them under node_modules helps ensure their dependencies get
    // deduped properly by npm.
    'command-palette',
    'find-and-replace',
    'go-to-line',
    'markdown-preview',
    'notifications',
    'status-bar',
    'tabs',
    'tree-view',
  ];
  const filesTypesToCopyFromPackage = new Set(['.cson', '.js', '.json', '.less']);
  const atomPackageData = {};
  const nodeModules = atomDir + '/node_modules';
  for (const pkg of atomPackages) {
    atomPackageData[pkg] = {};

    // Some Atom packages are written in CoffeeScript, so they need to be
    // transpiled for Browserify.
    const destinationDir = `${nodeModules}/${pkg}`;
    copySyncWatch(
      `${ATOM_SRC}/node_modules/${pkg}`,
      destinationDir,
      tree => fs.traverseTreeSync(
        tree,
        transpileFile,
        directoryName => {
          return directoryName !== 'node_modules';
        }
      )
    );

    const entries = atomPackageData[pkg]['files'] = {};
    fs.traverseTreeSync(
      destinationDir,
      fileName => {
        const extension = path.extname(fileName);
        if (filesTypesToCopyFromPackage.has(extension)) {
          entries[fileName] = fs.readFileSync(fileName, 'utf8');
        }
      },
      directoryName => {
        return directoryName !== 'node_modules';
      }
    );

    // Resolve the "main" attribute of package.json.
    const manifest = JSON.parse(fs.readFileSync(`${destinationDir}/package.json`), 'utf8');
    let {main} = manifest;

    if (main == null) {
      main = `${destinationDir}/index.js`;
    } else {
      main = path.resolve(destinationDir, main);
      if (fs.isDirectorySync(main)) {
        main = `${path.normalize(main)}/index.js`;
      }
      if (!fs.isFileSync(main)) {
        main = main + '.js';
      }
    }
    atomPackageData[pkg]['metadata'] = {main};
  }

  // Insert some shims.
  copyFileSyncWatch(
    root + '/shims/clipboard.js',
    atomDir + '/src/clipboard.js');
  [
    'remote',
    'screen',
    'shell',
  ].forEach(createShimPackageFromSingleFile.bind(null, nodeModules));

  // Call browserify on node_modules/atom/src/standalone-atom.js.
  const browserifyInputFile = atomDir + '/src/standalone-atom.js';
  copyFileSyncWatch(root + '/scripts/standalone-atom.js', browserifyInputFile);

  const modulesToFilter = new Set([
    // Modules with native dependencies that we do not expect to exercise at runtime.
    'onig-reg-exp',
    'runas',
    './squirrel-update',
    'tls',
    '../src/main-process/win-shell', // From exports/atom.js
  ]);

  const fullShims = new Set([
    'electron',
    'git-utils',
    'keyboard-layout',
    'marker-index',
    'nslog',
    'oniguruma',
    'pathwatcher',
    'scrollbar-style',
  ]);
  fullShims.forEach(createShimPackageFromDirectory.bind(null, nodeModules));

  const bundler = browserify(
    [
      browserifyInputFile,
    ],
    {
      // filter() is documented at: https://github.com/substack/module-deps#var-d--mdepsopts.
      filter(id) {
        return !modulesToFilter.has(id);
      },
      packageFilter(pkg, dir) {
        const {name} = pkg;
        if (fullShims.has(name)) {
          const clone = Object.assign({}, pkg);
          clone.browser = `${nodeModules}/${name}/index.js`;
          return clone;
        } else {
          return pkg;
        }
      },
      builtins: Object.assign(
        {
          atom: atomDir + '/exports/atom.js',
          electron: `${root}/shims/electron/index.js`
        },
        require('browserify/lib/builtins'),
        {
          buffer: require.resolve('browserfs/dist/shims/buffer.js'),
          fs: require.resolve('browserfs/dist/shims/fs.js'),
          path: require.resolve('browserfs/dist/shims/path.js'),
        }
      ),
      insertGlobalVars: {
        // process, Buffer, and BrowserFS globals.
        // BrowserFS global is not required if you include browserfs.js
        // in a script tag.
        process() { return "require('browserfs/dist/shims/process.js')" },
        Buffer() { return "require('buffer').Buffer" },
        BrowserFS() { return "require('" + require.resolve('browserfs') + "')" },
      },
      cache: {},
      packageCache: {},
      verbose: true,
    }
  ).on('log', console.log);

  // Map of absolute paths to file contents.
  // Each of these entries will be added to the BrowserFS.FileSystem.InMemory file store at startup.
  const ATOM_FILES_TO_ADD = {};

  const transformSuffixes = {
    // Currently, this matches:
    //     out/atom/node_modules/atom-space-pen-views/lib/select-list-view.js
    // Though ultimately we likely want to use this to overwrite require.resolve(), in general.
    '/node_modules/atom-space-pen-views/lib/select-list-view.js': function(file, src) {
      // TODO(mbolin): Replace this crude transform with a more precise and efficient one.

      // Here, we are trying to patch up:
      //
      //    atom.themes.requireStylesheet(require.resolve('../stylesheets/select-list.less'));
      //
      // The piece that is matched by our regex is:
      //
      //    ../stylesheets/select-list.less
      //
      // Recall that we need to make it look like the file exists on the filesystem at:
      // `node_modules/atom-space-pen-views/stylesheets/select-list.less`
      // in the case of the find-and-replace package.
      //
      // Because we are going to replace the require.resolve() call altogether in this case,
      // there will be no require() leftover, so Browserify will not try to resolve this file at
      // all, ony the BrowserFS.FileSystem.InMemory will have to.
      return src.replace(/require.resolve\(['"]([^\)]+)['"]\)/, function(fullMatch, arg) {
        const absolutePath = path.join(path.dirname(file), arg);
        // We need to ensure this resource is available at this path in BrowserFS.
        ATOM_FILES_TO_ADD[absolutePath] = fs.readFileSync(absolutePath, 'utf8');

        // Remember to stringify because the replacement must be a string literal.
        return JSON.stringify(absolutePath);
      });
    },
  };
  bundler.transform(
    function (file) {
      let patchTransform = null;
      for (const suffix in transformSuffixes) {
        if (file.endsWith(suffix)) {
          patchTransform = transformSuffixes[suffix];
          break;
        }
      }

      // TODO(mbolin): Prefer Node's built-in transform streams over through.
      if (patchTransform == null) {
        function write(buf) {
          this.queue(buf);
        }
        function end() {
          this.queue(null);
        }
        return through(write, end);
      } else {
        const data = [];
        function write(buf) {
          data.push(buf);
        }
        function end() {
          const src = data.join('');
          this.queue(patchTransform(file, src));
          this.queue(null);
        }
        return through(write, end);
      }
    },
    // We must set {global:true} so that transforms apply to things under node_modules.
    {global: true}
  );

  const ATOM_RESOURCE_PATH = '/Users/bolinfest/resourcePath';
  const resourceFoldersToCopy = [
    '/keymaps',
    '/menus',
    '/node_modules/atom-dark-syntax',
    '/node_modules/atom-dark-ui',
    '/node_modules/atom-light-syntax',
    '/node_modules/atom-light-ui',
    '/node_modules/atom-ui',
    '/resources',
    '/static',
  ];
  for (const folder of resourceFoldersToCopy) {
    fs.traverseTreeSync(
      ATOM_SRC + folder,
      fileName => {
        const relative = path.relative(ATOM_SRC, fileName);
        const entry = path.join(ATOM_RESOURCE_PATH, relative);
        ATOM_FILES_TO_ADD[entry] = fs.readFileSync(fileName, 'utf8');
      },
      directoryName => true
    );
  }

  function rmFile(filename) {
    try {
      fs.unlinkSync(filename);
    } catch(e) {
      // do nothing
    }
  }

  // Clear out files before we start appending to them.
  const atomJsFile = `${outDir}/atom.js`;
  rmFile(atomJsFile);
  const resourcesFile = `${outDir}/atom-resources.js`;
  rmFile(resourcesFile);

  const bundle = ids => {
    if (ids) {
      console.log('Changed', ids);
    }
    return bundler.bundle((error, content) => {
      if (error != null) {
        if (error.stack) {
          console.error(error.stack);
        } else {
          console.error(String(error));
        }
      } else {
        fs.appendFileSync(atomJsFile, JS_FILE_HEADER);
        fs.appendFileSync(atomJsFile, content);

        // Some stylesheet insists on loading octicons.woff relative to the .html page, so we
        // include both testpage.html and octicons.woff in the out/ directory.
        try {
          fs.symlinkSync(root + '/scripts/testpage.html', outDir + '/testpage.html');
        } catch(e) {
          // do nothing
        }

        function writeResources(data) {
          fs.appendFileSync(resourcesFile, data);
        }

        writeResources(JS_FILE_HEADER);

        writeResources(`var ATOM_RESOURCE_PATH = `);
        writeResources(JSON.stringify(ATOM_RESOURCE_PATH));
        writeResources(';\n');

        writeResources(`var ATOM_FILES_TO_ADD = `);
        writeResources(JSON.stringify(ATOM_FILES_TO_ADD));
        writeResources(';\n');

        writeResources(`var ATOM_PACKAGE_DATA = `);
        writeResources(JSON.stringify(atomPackageData));
        writeResources(';\n');

        writeResources('var ATOM_PACKAGE_ROOT_FROM_BROWSERIFY = ');
        writeResources(JSON.stringify(nodeModules));
        writeResources(';\n');

        startedWatching = willWatch;
      }
    });
  };

  if (willWatch) {
    bundler
      .plugin(watchify)
      .on('update', bundle);
    // Example of how to watch a one-off file and have it rebulid everything:
    chokidar.watch(root + '/keymaps').on('all', () => {
      if (startedWatching) {
        bundle();
      }
    });
  }

  bundle();
}

function transpileFile(absolutePath) {
  const ext = path.extname(absolutePath);
  if (!COMPILERS.hasOwnProperty(ext)) {
    return;
  }

  const compiler = COMPILERS[ext];
  const transpiledSource = compileFileAtPath(compiler, absolutePath, ext);

  // Replace the original file extension with .js.
  const outputFile = absolutePath.substring(0, absolutePath.length - ext.length) + '.js';
  fs.writeFileSync(outputFile, transpiledSource);
}

function createShimPackageFromSingleFile(nodeModules, moduleName) {
  const moduleDirectory = `${nodeModules}/${moduleName}`;
  makeCleanDir(moduleDirectory);
  copyFileSyncWatch(
    `${root}/shims/${moduleName}.js`,
    `${moduleDirectory}/${moduleName}.js`);
  fs.writeFileSync(
    moduleDirectory + '/package.json',
    JSON.stringify({
      name: moduleName,
      main: `./${moduleName}.js`,
    },
    /* replacer */ undefined,
    2));
}

function createShimPackageFromDirectory(nodeModules, moduleName) {
  const moduleDirectory = `${nodeModules}/${moduleName}`;
  makeCleanDir(moduleDirectory);
  copySyncWatch(`${root}/shims/${moduleName}`, moduleDirectory, tree => {});
}

function copySyncWatch(from, to, then) {
  fs.copySync(from, to);
  then(to);
  if (willWatch) {
    console.log('Will watch', from);
    chokidar.watch(from).on('all', (a, b) => {
      if (startedWatching) {
        fs.copySync(from, to);
        then(to);
      }
    });
  }
}

function copyFileSyncWatch(from, to) {
  fs.copyFileSync(from, to);
  if (willWatch) {
    console.log('Will watch file', from);
    chokidar.watch(from).on('all', () => {
      if (startedWatching) {
        fs.copyFileSync(from, to);
      }
    });
  }
}

function makeCleanDir(dir) {
  fs.removeSync(dir);
  fs.makeTreeSync(dir);
}

build();
