const path = require('path');

const async = require('async');
const { Emitter, Disposable } = require('event-kit');
const fs = require('fs-plus');
const Grim = require('grim');

const File = require('./file');
// This is the native code in this module that we have to avoid.
// const PathWatcher = require('./main');

// Extended: Represents a directory on disk that can be watched for changes.
class Directory {
  static initClass() {
    this.prototype.realPath = null;
    this.prototype.subscriptionCount = 0;
  }

  /*
  Section: Construction
  */

  // Public: Configures a new Directory instance, no files are accessed.
  //
  // * `directoryPath` A {String} containing the absolute path to the directory
  // * `symlink` (optional) A {Boolean} indicating if the path is a symlink.
  //   (default: false)
  constructor(directoryPath, symlink=false, includeDeprecatedAPIs=Grim.includeDeprecatedAPIs) {
    this.willAddSubscription = this.willAddSubscription.bind(this);
    this.didRemoveSubscription = this.didRemoveSubscription.bind(this);
    this.symlink = symlink;
    this.emitter = new Emitter;

    if (includeDeprecatedAPIs) {
      this.on('contents-changed-subscription-will-be-added', this.willAddSubscription);
      this.on('contents-changed-subscription-removed', this.didRemoveSubscription);
    }

    if (directoryPath) {
      directoryPath = path.normalize(directoryPath);
      // Remove a trailing slash
      if (directoryPath.length > 1 && directoryPath[directoryPath.length - 1] === path.sep) {
        directoryPath = directoryPath.substring(0, directoryPath.length - 1);
      }
    }
    this.path = directoryPath;

    if (fs.isCaseInsensitive()) { this.lowerCasePath = this.path.toLowerCase(); }
    if (Grim.includeDeprecatedAPIs) { this.reportOnDeprecations = true; }
  }

  // Public: Creates the directory on disk that corresponds to `::getPath()` if
  // no such directory already exists.
  //
  // * `mode` (optional) {Number} that defaults to `0777`.
  //
  // Returns a {Promise} that resolves once the directory is created on disk. It
  // resolves to a boolean value that is true if the directory was created or
  // false if it already existed.
  create(mode = 0o0777) {
    return this.exists().then(isExistingDirectory => {
      if (isExistingDirectory) { return false; }

      if (this.isRoot()) { throw Error(`Root directory does not exist: ${this.getPath()}`); }

      return this.getParent().create().then(() => {
        return new Promise((resolve, reject) => {
          return fs.mkdir(this.getPath(), mode, function(error) {
            if (error) {
              return reject(error);
            } else {
              return resolve(true);
            }
          });
        }
        );
      }
      );
    }
    );
  }
  /*
  Section: Event Subscription
  */

  // Public: Invoke the given callback when the directory's contents change.
  //
  // * `callback` {Function} to be called when the directory's contents change.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChange(callback) {
    this.willAddSubscription();
    return this.trackUnsubscription(this.emitter.on('did-change', callback));
  }

  willAddSubscription() {
    if (this.subscriptionCount === 0) { this.subscribeToNativeChangeEvents(); }
    return this.subscriptionCount++;
  }

  didRemoveSubscription() {
    this.subscriptionCount--;
    if (this.subscriptionCount === 0) { return this.unsubscribeFromNativeChangeEvents(); }
  }

  trackUnsubscription(subscription) {
    return new Disposable(() => {
      subscription.dispose();
      return this.didRemoveSubscription();
    }
    );
  }

  /*
  Section: Directory Metadata
  */

  // Public: Returns a {Boolean}, always false.
  isFile() { return false; }

  // Public: Returns a {Boolean}, always true.
  isDirectory() { return true; }

  // Public: Returns a {Boolean} indicating whether or not this is a symbolic link
  isSymbolicLink() {
    return this.symlink;
  }

  // Public: Returns a promise that resolves to a {Boolean}, true if the
  // directory exists, false otherwise.
  exists() {
    return new Promise(resolve => fs.exists(this.getPath(), resolve));
  }

  // Public: Returns a {Boolean}, true if the directory exists, false otherwise.
  existsSync() {
    return fs.existsSync(this.getPath());
  }

  // Public: Return a {Boolean}, true if this {Directory} is the root directory
  // of the filesystem, or false if it isn't.
  isRoot() {
    return this.getParent().getRealPathSync() === this.getRealPathSync();
  }

  /*
  Section: Managing Paths
  */

  // Public: Returns the directory's {String} path.
  //
  // This may include unfollowed symlinks or relative directory entries. Or it
  // may be fully resolved, it depends on what you give it.
  getPath() { return this.path; }

  // Public: Returns this directory's completely resolved {String} path.
  //
  // All relative directory entries are removed and symlinks are resolved to
  // their final destination.
  getRealPathSync() {
    if (this.realPath == null) {
      try {
        this.realPath = fs.realpathSync(this.path);
        if (fs.isCaseInsensitive()) { this.lowerCaseRealPath = this.realPath.toLowerCase(); }
      } catch (e) {
        this.realPath = this.path;
        if (fs.isCaseInsensitive()) { this.lowerCaseRealPath = this.lowerCasePath; }
      }
    }
    return this.realPath;
  }

  // Public: Returns the {String} basename of the directory.
  getBaseName() {
    return path.basename(this.path);
  }

  // Public: Returns the relative {String} path to the given path from this
  // directory.
  relativize(fullPath) {
    if (!fullPath) { return fullPath; }

    // Normalize forward slashes to back slashes on windows
    if (process.platform === 'win32') { fullPath = fullPath.replace(/\//g, '\\'); }

    if (fs.isCaseInsensitive()) {
      var pathToCheck = fullPath.toLowerCase();
      var directoryPath = this.lowerCasePath;
    } else {
      var pathToCheck = fullPath;
      var directoryPath = this.path;
    }

    if (pathToCheck === directoryPath) {
      return '';
    } else if (this.isPathPrefixOf(directoryPath, pathToCheck)) {
      return fullPath.substring(directoryPath.length + 1);
    }

    // Check real path
    this.getRealPathSync();
    if (fs.isCaseInsensitive()) {
      var directoryPath = this.lowerCaseRealPath;
    } else {
      var directoryPath = this.realPath;
    }

    if (pathToCheck === directoryPath) {
      return '';
    } else if (this.isPathPrefixOf(directoryPath, pathToCheck)) {
      return fullPath.substring(directoryPath.length + 1);
    } else {
      return fullPath;
    }
  }

  // Given a relative path, this resolves it to an absolute path relative to this
  // directory. If the path is already absolute or prefixed with a URI scheme, it
  // is returned unchanged.
  //
  // * `uri` A {String} containing the path to resolve.
  //
  // Returns a {String} containing an absolute path or `undefined` if the given
  // URI is falsy.
  resolve(relativePath) {
    if (!relativePath) { return; }

    if (__guard__(relativePath, x => x.match(/[A-Za-z0-9+-.]+:\/\//))) { // leave path alone if it has a scheme
      return relativePath;
    } else if (fs.isAbsolute(relativePath)) {
      return path.normalize(fs.absolute(relativePath));
    } else {
      return path.normalize(fs.absolute(path.join(this.getPath(), relativePath)));
    }
  }

  /*
  Section: Traversing
  */

  // Public: Traverse to the parent directory.
  //
  // Returns a {Directory}.
  getParent() {
    return new Directory(path.join(this.path, '..'));
  }

  // Public: Traverse within this Directory to a child File. This method doesn't
  // actually check to see if the File exists, it just creates the File object.
  //
  // * `filename` The {String} name of a File within this Directory.
  //
  // Returns a {File}.
  getFile(...filename) {
    return new File(path.join(this.getPath(), ...filename));
  }

  // Public: Traverse within this a Directory to a child Directory. This method
  // doesn't actually check to see if the Directory exists, it just creates the
  // Directory object.
  //
  // * `dirname` The {String} name of the child Directory.
  //
  // Returns a {Directory}.
  getSubdirectory(...dirname) {
    return new Directory(path.join(this.path, ...dirname));
  }

  // Public: Reads file entries in this directory from disk synchronously.
  //
  // Returns an {Array} of {File} and {Directory} objects.
  getEntriesSync() {
    let directories = [];
    let files = [];
    for (let entryPath of fs.listSync(this.path)) {
      try {
        var stat = fs.lstatSync(entryPath);
        var symlink = stat.isSymbolicLink();
        if (symlink) { stat = fs.statSync(entryPath); }
      } catch (error) {}

      if (__guard__(stat, x => x.isDirectory())) {
        directories.push(new Directory(entryPath, symlink));
      } else if (__guard__(stat, x1 => x1.isFile())) {
        files.push(new File(entryPath, symlink));
      }
    }

    return directories.concat(files);
  }

  // Public: Reads file entries in this directory from disk asynchronously.
  //
  // * `callback` A {Function} to call with the following arguments:
  //   * `error` An {Error}, may be null.
  //   * `entries` An {Array} of {File} and {Directory} objects.
  getEntries(callback) {
    return fs.list(this.path, function(error, entries) {
      if (error != null) { return callback(error); }

      let directories = [];
      let files = [];
      let addEntry = function(entryPath, stat, symlink, callback) {
        if (__guard__(stat, x => x.isDirectory())) {
          directories.push(new Directory(entryPath, symlink));
        } else if (__guard__(stat, x1 => x1.isFile())) {
          files.push(new File(entryPath, symlink));
        }
        return callback();
      };

      let statEntry = (entryPath, callback) =>
        fs.lstat(entryPath, function(error, stat) {
          if (__guard__(stat, x => x.isSymbolicLink())) {
            return fs.stat(entryPath, (error, stat) => addEntry(entryPath, stat, true, callback));
          } else {
            return addEntry(entryPath, stat, false, callback);
          }
        })
      ;

      return async.eachLimit(entries, 1, statEntry, () => callback(null, directories.concat(files)));
    });
  }

  // Public: Determines if the given path (real or symbolic) is inside this
  // directory. This method does not actually check if the path exists, it just
  // checks if the path is under this directory.
  //
  // * `pathToCheck` The {String} path to check.
  //
  // Returns a {Boolean} whether the given path is inside this directory.
  contains(pathToCheck) {
    if (!pathToCheck) { return false; }

    // Normalize forward slashes to back slashes on windows
    if (process.platform === 'win32') { pathToCheck = pathToCheck.replace(/\//g, '\\'); }

    if (fs.isCaseInsensitive()) {
      var directoryPath = this.lowerCasePath;
      pathToCheck = pathToCheck.toLowerCase();
    } else {
      var directoryPath = this.path;
    }

    if (this.isPathPrefixOf(directoryPath, pathToCheck)) { return true; }

    // Check real path
    this.getRealPathSync();
    if (fs.isCaseInsensitive()) {
      var directoryPath = this.lowerCaseRealPath;
    } else {
      var directoryPath = this.realPath;
    }

    return this.isPathPrefixOf(directoryPath, pathToCheck);
  }

  /*
  Section: Private
  */

  subscribeToNativeChangeEvents() {
    return this.watchSubscription != null ? this.watchSubscription : (this.watchSubscription = PathWatcher.watch(this.path, eventType => {
      if (eventType === 'change') {
        if (Grim.includeDeprecatedAPIs) { this.emit('contents-changed'); }
        return this.emitter.emit('did-change');
      }
    }
    ));
  }

  unsubscribeFromNativeChangeEvents() {
    if (this.watchSubscription != null) {
      this.watchSubscription.close();
      return this.watchSubscription = null;
    }
  }

  // Does given full path start with the given prefix?
  isPathPrefixOf(prefix, fullPath) {
    return fullPath.indexOf(prefix) === 0 && fullPath[prefix.length] === path.sep;
  }
};
Directory.initClass();

if (Grim.includeDeprecatedAPIs) {
  let EmitterMixin = require('emissary').Emitter;
  EmitterMixin.includeInto(Directory);

  Directory.prototype.on = function(eventName) {
    if (eventName === 'contents-changed') {
      Grim.deprecate("Use Directory::onDidChange instead");
    } else if (this.reportOnDeprecations) {
      Grim.deprecate("Subscribing via ::on is deprecated. Use documented event subscription methods instead.");
    }

    return EmitterMixin.prototype.on.apply(this, arguments);
  };
}

function __guard__(value, transform) {
  return (typeof value !== 'undefined' && value !== null) ? transform(value) : undefined;
}

module.exports = Directory;
