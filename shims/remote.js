var lastWindow;
exports.getCurrentWindow = function() {
  if (lastWindow) {
    return lastWindow;
  }

  lastWindow = {
    domWindow: window,
    loadSettings: {},
    getPosition: function() {
      return [window.screenX, window.screenY];
    },
    getSize: function() {
      return [window.innerWidth, window.innerHeight];
    },
  }

  return lastWindow;
};
