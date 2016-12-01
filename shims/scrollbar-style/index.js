const {Emitter} = require('event-kit');

const emitter = new Emitter();

module.exports = {
  getPreferredScrollbarStyle() {
    // 'overlay' seems more appropriate than 'legacy'.
    return 'overlay';
  },

  onDidChangePreferredScrollbarStyle(callback) {
    return emitter.on('did-change-preferred-scrollbar-style', callback);
  },

  observePreferredScrollbarStyle(callback) {
    callback(this.getPreferredScrollbarStyle());
    return this.onDidChangePreferredScrollbarStyle(callback);
  },
};
