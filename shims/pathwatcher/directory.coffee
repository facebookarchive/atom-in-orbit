path = require 'path'

async = require 'async'
{Emitter, Disposable} = require 'event-kit'
fs = require 'fs-plus'
Grim = require 'grim'

File = require './file'
PathWatcher = require './main'

# Extended: Represents a directory on disk that can be watched for changes.
module.exports =
class Directory
  realPath: null
  subscriptionCount: 0

  ###
  Section: Construction
  ###

  # Public: Configures a new Directory instance, no files are accessed.
  #
  # * `directoryPath` A {String} containing the absolute path to the directory
  # * `symlink` (optional) A {Boolean} indicating if the path is a symlink.
  #   (default: false)
  constructor: (directoryPath, @symlink=false, includeDeprecatedAPIs=Grim.includeDeprecatedAPIs) ->
    @emitter = new Emitter

    if includeDeprecatedAPIs
      @on 'contents-changed-subscription-will-be-added', @willAddSubscription
      @on 'contents-changed-subscription-removed', @didRemoveSubscription

    if directoryPath
      directoryPath = path.normalize(directoryPath)
      # Remove a trailing slash
      if directoryPath.length > 1 and directoryPath[directoryPath.length - 1] is path.sep
        directoryPath = directoryPath.substring(0, directoryPath.length - 1)
    @path = directoryPath

    @lowerCasePath = @path.toLowerCase() if fs.isCaseInsensitive()
    @reportOnDeprecations = true if Grim.includeDeprecatedAPIs

  # Public: Creates the directory on disk that corresponds to `::getPath()` if
  # no such directory already exists.
  #
  # * `mode` (optional) {Number} that defaults to `0777`.
  #
  # Returns a {Promise} that resolves once the directory is created on disk. It
  # resolves to a boolean value that is true if the directory was created or
  # false if it already existed.
  create: (mode = 0o0777) ->
    @exists().then (isExistingDirectory) =>
      return false if isExistingDirectory

      throw Error("Root directory does not exist: #{@getPath()}") if @isRoot()

      @getParent().create().then =>
        new Promise (resolve, reject) =>
          fs.mkdir @getPath(), mode, (error) ->
            if error
              reject error
            else
              resolve true
  ###
  Section: Event Subscription
  ###

  # Public: Invoke the given callback when the directory's contents change.
  #
  # * `callback` {Function} to be called when the directory's contents change.
  #
  # Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChange: (callback) ->
    @willAddSubscription()
    @trackUnsubscription(@emitter.on('did-change', callback))

  willAddSubscription: =>
    @subscribeToNativeChangeEvents() if @subscriptionCount is 0
    @subscriptionCount++

  didRemoveSubscription: =>
    @subscriptionCount--
    @unsubscribeFromNativeChangeEvents() if @subscriptionCount is 0

  trackUnsubscription: (subscription) ->
    new Disposable =>
      subscription.dispose()
      @didRemoveSubscription()

  ###
  Section: Directory Metadata
  ###

  # Public: Returns a {Boolean}, always false.
  isFile: -> false

  # Public: Returns a {Boolean}, always true.
  isDirectory: -> true

  # Public: Returns a {Boolean} indicating whether or not this is a symbolic link
  isSymbolicLink: ->
    @symlink

  # Public: Returns a promise that resolves to a {Boolean}, true if the
  # directory exists, false otherwise.
  exists: ->
    new Promise (resolve) => fs.exists(@getPath(), resolve)

  # Public: Returns a {Boolean}, true if the directory exists, false otherwise.
  existsSync: ->
    fs.existsSync(@getPath())

  # Public: Return a {Boolean}, true if this {Directory} is the root directory
  # of the filesystem, or false if it isn't.
  isRoot: ->
    @getParent().getRealPathSync() is @getRealPathSync()

  ###
  Section: Managing Paths
  ###

  # Public: Returns the directory's {String} path.
  #
  # This may include unfollowed symlinks or relative directory entries. Or it
  # may be fully resolved, it depends on what you give it.
  getPath: -> @path

  # Public: Returns this directory's completely resolved {String} path.
  #
  # All relative directory entries are removed and symlinks are resolved to
  # their final destination.
  getRealPathSync: ->
    unless @realPath?
      try
        @realPath = fs.realpathSync(@path)
        @lowerCaseRealPath = @realPath.toLowerCase() if fs.isCaseInsensitive()
      catch e
        @realPath = @path
        @lowerCaseRealPath = @lowerCasePath if fs.isCaseInsensitive()
    @realPath

  # Public: Returns the {String} basename of the directory.
  getBaseName: ->
    path.basename(@path)

  # Public: Returns the relative {String} path to the given path from this
  # directory.
  relativize: (fullPath) ->
    return fullPath unless fullPath

    # Normalize forward slashes to back slashes on windows
    fullPath = fullPath.replace(/\//g, '\\') if process.platform is 'win32'

    if fs.isCaseInsensitive()
      pathToCheck = fullPath.toLowerCase()
      directoryPath = @lowerCasePath
    else
      pathToCheck = fullPath
      directoryPath = @path

    if pathToCheck is directoryPath
      return ''
    else if @isPathPrefixOf(directoryPath, pathToCheck)
      return fullPath.substring(directoryPath.length + 1)

    # Check real path
    @getRealPathSync()
    if fs.isCaseInsensitive()
      directoryPath = @lowerCaseRealPath
    else
      directoryPath = @realPath

    if pathToCheck is directoryPath
      ''
    else if @isPathPrefixOf(directoryPath, pathToCheck)
      fullPath.substring(directoryPath.length + 1)
    else
      fullPath

  # Given a relative path, this resolves it to an absolute path relative to this
  # directory. If the path is already absolute or prefixed with a URI scheme, it
  # is returned unchanged.
  #
  # * `uri` A {String} containing the path to resolve.
  #
  # Returns a {String} containing an absolute path or `undefined` if the given
  # URI is falsy.
  resolve: (relativePath) ->
    return unless relativePath

    if relativePath?.match(/[A-Za-z0-9+-.]+:\/\//) # leave path alone if it has a scheme
      relativePath
    else if fs.isAbsolute(relativePath)
      path.normalize(fs.absolute(relativePath))
    else
      path.normalize(fs.absolute(path.join(@getPath(), relativePath)))

  ###
  Section: Traversing
  ###

  # Public: Traverse to the parent directory.
  #
  # Returns a {Directory}.
  getParent: ->
    new Directory(path.join @path, '..')

  # Public: Traverse within this Directory to a child File. This method doesn't
  # actually check to see if the File exists, it just creates the File object.
  #
  # * `filename` The {String} name of a File within this Directory.
  #
  # Returns a {File}.
  getFile: (filename...) ->
    new File(path.join @getPath(), filename...)

  # Public: Traverse within this a Directory to a child Directory. This method
  # doesn't actually check to see if the Directory exists, it just creates the
  # Directory object.
  #
  # * `dirname` The {String} name of the child Directory.
  #
  # Returns a {Directory}.
  getSubdirectory: (dirname...) ->
    new Directory(path.join @path, dirname...)

  # Public: Reads file entries in this directory from disk synchronously.
  #
  # Returns an {Array} of {File} and {Directory} objects.
  getEntriesSync: ->
    directories = []
    files = []
    for entryPath in fs.listSync(@path)
      try
        stat = fs.lstatSync(entryPath)
        symlink = stat.isSymbolicLink()
        stat = fs.statSync(entryPath) if symlink

      if stat?.isDirectory()
        directories.push(new Directory(entryPath, symlink))
      else if stat?.isFile()
        files.push(new File(entryPath, symlink))

    directories.concat(files)

  # Public: Reads file entries in this directory from disk asynchronously.
  #
  # * `callback` A {Function} to call with the following arguments:
  #   * `error` An {Error}, may be null.
  #   * `entries` An {Array} of {File} and {Directory} objects.
  getEntries: (callback) ->
    fs.list @path, (error, entries) ->
      return callback(error) if error?

      directories = []
      files = []
      addEntry = (entryPath, stat, symlink, callback) ->
        if stat?.isDirectory()
          directories.push(new Directory(entryPath, symlink))
        else if stat?.isFile()
          files.push(new File(entryPath, symlink))
        callback()

      statEntry = (entryPath, callback) ->
        fs.lstat entryPath, (error, stat) ->
          if stat?.isSymbolicLink()
            fs.stat entryPath, (error, stat) ->
              addEntry(entryPath, stat, true, callback)
          else
            addEntry(entryPath, stat, false, callback)

      async.eachLimit entries, 1, statEntry, ->
        callback(null, directories.concat(files))

  # Public: Determines if the given path (real or symbolic) is inside this
  # directory. This method does not actually check if the path exists, it just
  # checks if the path is under this directory.
  #
  # * `pathToCheck` The {String} path to check.
  #
  # Returns a {Boolean} whether the given path is inside this directory.
  contains: (pathToCheck) ->
    return false unless pathToCheck

    # Normalize forward slashes to back slashes on windows
    pathToCheck = pathToCheck.replace(/\//g, '\\') if process.platform is 'win32'

    if fs.isCaseInsensitive()
      directoryPath = @lowerCasePath
      pathToCheck = pathToCheck.toLowerCase()
    else
      directoryPath = @path

    return true if @isPathPrefixOf(directoryPath, pathToCheck)

    # Check real path
    @getRealPathSync()
    if fs.isCaseInsensitive()
      directoryPath = @lowerCaseRealPath
    else
      directoryPath = @realPath

    @isPathPrefixOf(directoryPath, pathToCheck)

  ###
  Section: Private
  ###

  subscribeToNativeChangeEvents: ->
    @watchSubscription ?= PathWatcher.watch @path, (eventType) =>
      if eventType is 'change'
        @emit 'contents-changed' if Grim.includeDeprecatedAPIs
        @emitter.emit 'did-change'

  unsubscribeFromNativeChangeEvents: ->
    if @watchSubscription?
      @watchSubscription.close()
      @watchSubscription = null

  # Does given full path start with the given prefix?
  isPathPrefixOf: (prefix, fullPath) ->
    fullPath.indexOf(prefix) is 0 and fullPath[prefix.length] is path.sep

if Grim.includeDeprecatedAPIs
  EmitterMixin = require('emissary').Emitter
  EmitterMixin.includeInto(Directory)

  Directory::on = (eventName) ->
    if eventName is 'contents-changed'
      Grim.deprecate("Use Directory::onDidChange instead")
    else if @reportOnDeprecations
      Grim.deprecate("Subscribing via ::on is deprecated. Use documented event subscription methods instead.")

    EmitterMixin::on.apply(this, arguments)
