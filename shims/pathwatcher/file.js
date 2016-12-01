const crypto = require('crypto');
const path = require('path');

const _ = require('underscore-plus');
const { Emitter, Disposable } = require('event-kit');
const fs = require('fs-plus');
const Grim = require('grim');

let runas = null; // Defer until used
let iconv = null; // Defer until used

let Directory = null;
// This is the native code in this module that we have to avoid.
// const PathWatcher = require('./main');

// Extended: Represents an individual file that can be watched, read from, and
// written to.
class File {
  static initClass() {
    this.prototype.encoding = 'utf8';
    this.prototype.realPath = null;
    this.prototype.subscriptionCount = 0;
  }

  /*
  Section: Construction
  */

  // Public: Configures a new File instance, no files are accessed.
  //
  // * `filePath` A {String} containing the absolute path to the file
  // * `symlink` A {Boolean} indicating if the path is a symlink (default: false).
  constructor(filePath, symlink=false, includeDeprecatedAPIs=Grim.includeDeprecatedAPIs) {
    this.willAddSubscription = this.willAddSubscription.bind(this);
    this.didRemoveSubscription = this.didRemoveSubscription.bind(this);
    this.symlink = symlink;
    if (filePath) { filePath = path.normalize(filePath); }
    this.path = filePath;
    this.emitter = new Emitter;

    if (includeDeprecatedAPIs) {
      this.on('contents-changed-subscription-will-be-added', this.willAddSubscription);
      this.on('moved-subscription-will-be-added', this.willAddSubscription);
      this.on('removed-subscription-will-be-added', this.willAddSubscription);
      this.on('contents-changed-subscription-removed', this.didRemoveSubscription);
      this.on('moved-subscription-removed', this.didRemoveSubscription);
      this.on('removed-subscription-removed', this.didRemoveSubscription);
    }

    this.cachedContents = null;
    this.reportOnDeprecations = true;
  }

  // Public: Creates the file on disk that corresponds to `::getPath()` if no
  // such file already exists.
  //
  // Returns a {Promise} that resolves once the file is created on disk. It
  // resolves to a boolean value that is true if the file was created or false if
  // it already existed.
  create() {
    return this.exists().then(isExistingFile => {
      if (!isExistingFile) {
        let parent = this.getParent();
        return parent.create().then(() => {
          return this.write('').then(() => true);
        }
        );
      } else {
        return false;
      }
    }
    );
  }

  /*
  Section: Event Subscription
  */

  // Public: Invoke the given callback when the file's contents change.
  //
  // * `callback` {Function} to be called when the file's contents change.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChange(callback) {
    this.willAddSubscription();
    return this.trackUnsubscription(this.emitter.on('did-change', callback));
  }

  // Public: Invoke the given callback when the file's path changes.
  //
  // * `callback` {Function} to be called when the file's path changes.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRename(callback) {
    this.willAddSubscription();
    return this.trackUnsubscription(this.emitter.on('did-rename', callback));
  }

  // Public: Invoke the given callback when the file is deleted.
  //
  // * `callback` {Function} to be called when the file is deleted.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidDelete(callback) {
    this.willAddSubscription();
    return this.trackUnsubscription(this.emitter.on('did-delete', callback));
  }

  // Public: Invoke the given callback when there is an error with the watch.
  // When your callback has been invoked, the file will have unsubscribed from
  // the file watches.
  //
  // * `callback` {Function} callback
  //   * `errorObject` {Object}
  //     * `error` {Object} the error object
  //     * `handle` {Function} call this to indicate you have handled the error.
  //       The error will not be thrown if this function is called.
  onWillThrowWatchError(callback) {
    return this.emitter.on('will-throw-watch-error', callback);
  }

  willAddSubscription() {
    this.subscriptionCount++;
    try {
      return this.subscribeToNativeChangeEvents();
    } catch (error) {}
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
  Section: File Metadata
  */

  // Public: Returns a {Boolean}, always true.
  isFile() { return true; }

  // Public: Returns a {Boolean}, always false.
  isDirectory() { return false; }

  // Public: Returns a {Boolean} indicating whether or not this is a symbolic link
  isSymbolicLink() {
    return this.symlink;
  }

  // Public: Returns a promise that resolves to a {Boolean}, true if the file
  // exists, false otherwise.
  exists() {
    return new Promise(resolve => {
      return fs.exists(this.getPath(), resolve);
    }
    );
  }

  // Public: Returns a {Boolean}, true if the file exists, false otherwise.
  existsSync() {
    return fs.existsSync(this.getPath());
  }

  // Public: Get the SHA-1 digest of this file
  //
  // Returns a promise that resolves to a {String}.
  getDigest() {
    if (this.digest != null) {
      return Promise.resolve(this.digest);
    } else {
      return this.read().then(() => this.digest); // read assigns digest as a side-effect
    }
  }

  // Public: Get the SHA-1 digest of this file
  //
  // Returns a {String}.
  getDigestSync() {
    if (!this.digest) { this.readSync(); }
    return this.digest;
  }

  setDigest(contents) {
    return this.digest = crypto.createHash('sha1').update(contents != null ? contents : '').digest('hex');
  }

  // Public: Sets the file's character set encoding name.
  //
  // * `encoding` The {String} encoding to use (default: 'utf8')
  setEncoding(encoding='utf8') {
    // Throws if encoding doesn't exist. Better to throw an exception early
    // instead of waiting until the file is saved.

    if (encoding !== 'utf8') {
      if (typeof iconv === 'undefined' || iconv === null) { iconv = require('iconv-lite'); }
      iconv.getCodec(encoding);
    }

    return this.encoding = encoding;
  }

  // Public: Returns the {String} encoding name for this file (default: 'utf8').
  getEncoding() { return this.encoding; }

  /*
  Section: Managing Paths
  */

  // Public: Returns the {String} path for the file.
  getPath() { return this.path; }

  // Sets the path for the file.
  setPath(path1) {
    this.path = path1;
    return this.realPath = null;
  }

  // Public: Returns this file's completely resolved {String} path.
  getRealPathSync() {
    if (this.realPath == null) {
      try {
        this.realPath = fs.realpathSync(this.path);
      } catch (error) {
        this.realPath = this.path;
      }
    }
    return this.realPath;
  }

  // Public: Returns a promise that resolves to the file's completely resolved {String} path.
  getRealPath() {
    if (this.realPath != null) {
      return Promise.resolve(this.realPath);
    } else {
      return new Promise((resolve, reject) => {
        return fs.realpath(this.path, (err, result) => {
          if (err != null) {
            return reject(err);
          } else {
            return resolve(this.realPath = result);
          }
        }
        );
      }
      );
    }
  }

  // Public: Return the {String} filename without any directory information.
  getBaseName() {
    return path.basename(this.path);
  }

  /*
  Section: Traversing
  */

  // Public: Return the {Directory} that contains this file.
  getParent() {
    if (typeof Directory === 'undefined' || Directory === null) { Directory = require('./directory'); }
    return new Directory(path.dirname(this.path));
  }

  /*
  Section: Reading and Writing
  */

  readSync(flushCache) {
    if (!this.existsSync()) {
      this.cachedContents = null;
    } else if ((this.cachedContents == null) || flushCache) {
      let encoding = this.getEncoding();
      if (encoding === 'utf8') {
        this.cachedContents = fs.readFileSync(this.getPath(), encoding);
      } else {
        if (typeof iconv === 'undefined' || iconv === null) { iconv = require('iconv-lite'); }
        this.cachedContents = iconv.decode(fs.readFileSync(this.getPath()), encoding);
      }
    }

    this.setDigest(this.cachedContents);
    return this.cachedContents;
  }

  writeFileSync(filePath, contents) {
    let encoding = this.getEncoding();
    if (encoding === 'utf8') {
      return fs.writeFileSync(filePath, contents, {encoding});
    } else {
      if (typeof iconv === 'undefined' || iconv === null) { iconv = require('iconv-lite'); }
      return fs.writeFileSync(filePath, iconv.encode(contents, encoding));
    }
  }

  // Public: Reads the contents of the file.
  //
  // * `flushCache` A {Boolean} indicating whether to require a direct read or if
  //   a cached copy is acceptable.
  //
  // Returns a promise that resolves to a String.
  read(flushCache) {
    if ((this.cachedContents != null) && !flushCache) {
      var promise = Promise.resolve(this.cachedContents);
    } else {
      var promise = new Promise((resolve, reject) => {
        let content = [];
        let readStream = this.createReadStream();

        readStream.on('data', chunk => content.push(chunk));

        readStream.on('end', () => resolve(content.join('')));

        return readStream.on('error', function(error) {
          if (error.code === 'ENOENT') {
            return resolve(null);
          } else {
            return reject(error);
          }
        });
      }
      );
    }

    return promise.then(contents => {
      this.setDigest(contents);
      return this.cachedContents = contents;
    }
    );
  }

  // Public: Returns a stream to read the content of the file.
  //
  // Returns a {ReadStream} object.
  createReadStream() {
    let encoding = this.getEncoding();
    if (encoding === 'utf8') {
      return fs.createReadStream(this.getPath(), {encoding});
    } else {
      if (typeof iconv === 'undefined' || iconv === null) { iconv = require('iconv-lite'); }
      return fs.createReadStream(this.getPath()).pipe(iconv.decodeStream(encoding));
    }
  }

  // Public: Overwrites the file with the given text.
  //
  // * `text` The {String} text to write to the underlying file.
  //
  // Returns a {Promise} that resolves when the file has been written.
  write(text) {
    return this.exists().then(previouslyExisted => {
      return this.writeFile(this.getPath(), text).then(() => {
        this.cachedContents = text;
        this.setDigest(text);
        if (!previouslyExisted && this.hasSubscriptions()) { this.subscribeToNativeChangeEvents(); }
        return undefined;
      }
      );
    }
    );
  }

  // Public: Returns a stream to write content to the file.
  //
  // Returns a {WriteStream} object.
  createWriteStream() {
    let encoding = this.getEncoding();
    if (encoding === 'utf8') {
      return fs.createWriteStream(this.getPath(), {encoding});
    } else {
      if (typeof iconv === 'undefined' || iconv === null) { iconv = require('iconv-lite'); }
      let stream = iconv.encodeStream(encoding);
      stream.pipe(fs.createWriteStream(this.getPath()));
      return stream;
    }
  }

  // Public: Overwrites the file with the given text.
  //
  // * `text` The {String} text to write to the underlying file.
  //
  // Returns undefined.
  writeSync(text) {
    let previouslyExisted = this.existsSync();
    this.writeFileWithPrivilegeEscalationSync(this.getPath(), text);
    this.cachedContents = text;
    this.setDigest(text);
    if (!previouslyExisted && this.hasSubscriptions()) { this.subscribeToNativeChangeEvents(); }
    return undefined;
  }

  safeWriteSync(text) {
    try {
      let fd = fs.openSync(this.getPath(), 'w');
      fs.writeSync(fd, text);

      // Ensure file contents are really on disk before proceeding
      fs.fdatasyncSync(fd);
      fs.closeSync(fd);

      // Ensure file directory entry is really on disk before proceeding
      //
      // Windows doesn't support syncing on directories so we'll just have to live
      // with less safety on that platform.
      if (process.platform !== 'win32') {
        try {
          let directoryFD = fs.openSync(path.dirname(this.getPath()), 'r');
          fs.fdatasyncSync(directoryFD);
          fs.closeSync(directoryFD);
        } catch (error) {
          console.warn(`Non-fatal error syncing parent directory of ${this.getPath()}`);
        }
      }
      return;
    } catch (error) {
      if (error.code === 'EACCES' && process.platform === 'darwin') {
        if (typeof runas === 'undefined' || runas === null) { runas = require('runas'); }
        // Use dd to read from stdin and write to the file path.
        if (runas('/bin/dd', [`of=${this.getPath()}`], {stdin: text, admin: true}) !== 0) {
          throw error;
        }
        // Use sync to force completion of pending disk writes.
        if (runas('/bin/sync', [], {admin: true}) !== 0) {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  writeFile(filePath, contents) {
    let encoding = this.getEncoding();
    if (encoding === 'utf8') {
      return new Promise((resolve, reject) =>
        fs.writeFile(filePath, contents, {encoding}, function(err, result) {
          if (err != null) {
            return reject(err);
          } else {
            return resolve(result);
          }
        })
      );
    } else {
      if (typeof iconv === 'undefined' || iconv === null) { iconv = require('iconv-lite'); }
      return new Promise((resolve, reject) =>
        fs.writeFile(filePath, iconv.encode(contents, encoding), function(err, result) {
          if (err != null) {
            return reject(err);
          } else {
            return resolve(result);
          }
        })
      );
    }
  }

  // Writes the text to specified path.
  //
  // Privilege escalation would be asked when current user doesn't have
  // permission to the path.
  writeFileWithPrivilegeEscalationSync(filePath, text) {
    try {
      return this.writeFileSync(filePath, text);
    } catch (error) {
      if (error.code === 'EACCES' && process.platform === 'darwin') {
        if (typeof runas === 'undefined' || runas === null) { runas = require('runas'); }
        // Use dd to read from stdin and write to the file path, same thing could
        // be done with tee but it would also copy the file to stdout.
        if (runas('/bin/dd', [`of=${filePath}`], {stdin: text, admin: true}) !== 0) {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  safeRemoveSync() {
    try {
      // Ensure new file contents are really on disk before proceeding
      let fd = fs.openSync(this.getPath(), 'a');
      fs.fdatasyncSync(fd);
      fs.closeSync(fd);

      fs.removeSync(this.getPath());
      return;
    } catch (error) {
      if (error.code === 'EACCES' && process.platform === 'darwin') {
        if (typeof runas === 'undefined' || runas === null) { runas = require('runas'); }
        // Use sync to force completion of pending disk writes.
        if (runas('/bin/sync', [], {admin: true}) !== 0) {
          throw error;
        }
        if (runas('/bin/rm', ['-f', this.getPath()], {admin: true}) !== 0) {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  /*
  Section: Private
  */

  handleNativeChangeEvent(eventType, eventPath) {
    switch (eventType) {
      case 'delete':
        this.unsubscribeFromNativeChangeEvents();
        return this.detectResurrectionAfterDelay();
      case 'rename':
        this.setPath(eventPath);
        if (Grim.includeDeprecatedAPIs) { this.emit('moved'); }
        return this.emitter.emit('did-rename');
      case 'change': case 'resurrect':
        let oldContents = this.cachedContents;
        let handleReadError = error => {
          // We cant read the file, so we GTFO on the watch
          this.unsubscribeFromNativeChangeEvents();

          let handled = false;
          let handle = () => handled = true;
          error.eventType = eventType;
          this.emitter.emit('will-throw-watch-error', {error, handle});
          if (!handled) {
            let newError = new Error(`Cannot read file after file \`${eventType}\` event: ${this.path}`);
            newError.originalError = error;
            newError.code = "ENOENT";
            newError.path;
            // I want to throw the error here, but it stops the event loop or
            // something. No longer do interval or timeout methods get run!
            // throw newError
            return console.error(newError);
          }
        };

        try {
          let handleResolve = newContents => {
            if (oldContents !== newContents) {
              if (Grim.includeDeprecatedAPIs) { this.emit('contents-changed'); }
              return this.emitter.emit('did-change');
            }
          };

          return this.read(true).then(handleResolve, handleReadError);
        } catch (error) {
          return handleReadError(error);
        }
    }
  }

  detectResurrectionAfterDelay() {
    return _.delay((() => this.detectResurrection()), 50);
  }

  detectResurrection() {
    return this.exists().then(exists => {
      if (exists) {
        this.subscribeToNativeChangeEvents();
        return this.handleNativeChangeEvent('resurrect', this.getPath());
      } else {
        this.cachedContents = null;
        if (Grim.includeDeprecatedAPIs) { this.emit('removed'); }
        return this.emitter.emit('did-delete');
      }
    }
    );
  }

  subscribeToNativeChangeEvents() {
    throw('TODO: Need a workaround here!');
    return this.watchSubscription != null ? this.watchSubscription : (this.watchSubscription = PathWatcher.watch(this.path, (...args) => {
      return this.handleNativeChangeEvent(...args);
    }
    ));
  }

  unsubscribeFromNativeChangeEvents() {
    if (this.watchSubscription != null) {
      this.watchSubscription.close();
      return this.watchSubscription = null;
    }
  }
};
File.initClass();

if (Grim.includeDeprecatedAPIs) {
  let EmitterMixin = require('emissary').Emitter;
  EmitterMixin.includeInto(File);

  File.prototype.on = function(eventName) {
    switch (eventName) {
      case 'contents-changed':
        Grim.deprecate("Use File::onDidChange instead");
        break;
      case 'moved':
        Grim.deprecate("Use File::onDidRename instead");
        break;
      case 'removed':
        Grim.deprecate("Use File::onDidDelete instead");
        break;
      default:
        if (this.reportOnDeprecations) {
          Grim.deprecate("Subscribing via ::on is deprecated. Use documented event subscription methods instead.");
        }
    }

    return EmitterMixin.prototype.on.apply(this, arguments);
  };
} else {
  File.prototype.hasSubscriptions = function() {
    return this.subscriptionCount > 0;
  };
}

module.exports = File;
