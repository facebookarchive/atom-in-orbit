function Clipboard() {
  this.metadata = null;
  this.signatureForMetadata = null;
}

var _currentClipboard = '';

Clipboard.prototype = {
  md5: function(text) {
    // TODO: Pure JS implementation of md5.
    return "6d5c9d3b291785b69f79aa5bda210b79cbb8bd94";
  },

  write: function(text, metadata) {
    _currentClipboard = text;
  },
  read: function() {
    return _currentClipboard;
  },
  readWithMetadata: function() {
    return {text: _currentClipboard};
  },
};

['cut', 'copy', 'paste'].forEach(function(eventName) {
  document.addEventListener(eventName, function(e) {
    var editor = Array.from(atom.textEditors.editors)[0];

    if (eventName === 'paste') {
      _currentClipboard = e.clipboardData.getData('text/plain');
      editor.pasteText();
    }

    if (eventName === 'copy') {
      editor.copySelectedText();
      e.clipboardData.setData('text/plain', _currentClipboard);
    }

    if (eventName === 'cut') {
      editor.cutSelectedText();
      e.clipboardData.setData('text/plain', _currentClipboard);
    }

    e.preventDefault();
  });
});

module.exports = Clipboard;
