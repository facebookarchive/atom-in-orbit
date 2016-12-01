const listeners = {};
const handlers = {};

function registerGetterSetter(action, ...initialValue) {
  var value = initialValue;
  handlers['set-' + action] = function(...args) {
    value = args;
    dispatch('ipc-helpers-set-' + action + '-response', ...value);
  }
  handlers['get-' + action] = function(...args) {
    value = args;
    dispatch('ipc-helpers-get-' + action + '-response', ...value);
  }
}
function registerMethod(action, value) {
  handlers[action] = function(...args) {
    dispatch('ipc-helpers-' + action + '-response', value);
  }
}

let temporaryWindowState = JSON.stringify({
  version: 1,
  project: {
    deserializer: "Project",
    paths: [],
    buffers: []
  },
  workspace: {
    deserializer: "Workspace",
    paneContainer: {
      deserializer: "PaneContainer",
      version: 1,
      root: {
        deserializer: "Pane",
        id: 3,
        items: [],
      },
    },
    packagesWithActiveGrammars: [

    ],
    destroyedItemURIs: [

    ],
  },
  fullScreen: false,
  windowDimensions: {
    x: 130,
    y: 45,
    width: 918,
    height: 760,
    maximized: false,
  },
  textEditors: {
    editorGrammarOverrides: {},
  },
});

// TODO(mbolin): Figure out how to use the above instead of this opaque string.
temporaryWindowState = '{"version":1,"project":{"deserializer":"Project","paths":[],"buffers":[{"id":"118017ce453321af3b41bd5ece2d8413","text":"","defaultMarkerLayerId":"34","markerLayers":{"1":{"id":"1","maintainHistory":false,"persistent":true,"markersById":{},"version":2},"3":{"id":"3","maintainHistory":true,"persistent":true,"markersById":{"1":{"range":{"start":{"row":0,"column":0},"end":{"row":0,"column":0}},"properties":{},"reversed":false,"tailed":false,"valid":true,"invalidate":"never"}},"version":2},"4":{"id":"4","maintainHistory":false,"persistent":true,"markersById":{},"version":2}},"displayLayers":{"0":{"id":0,"foldsMarkerLayerId":"1"}},"nextMarkerLayerId":40,"nextDisplayLayerId":1,"history":{"version":5,"nextCheckpointId":1,"undoStack":[],"redoStack":[],"maxUndoEntries":10000},"encoding":"utf8","preferredLineEnding":"\\n","nextMarkerId":2}]},"workspace":{"deserializer":"Workspace","paneContainer":{"deserializer":"PaneContainer","version":1,"root":{"deserializer":"Pane","id":3,"items":[{"deserializer":"TextEditor","version":1,"displayBuffer":{"tokenizedBuffer":{"deserializer":"TokenizedBuffer","bufferId":"118017ce453321af3b41bd5ece2d8413","tabLength":2,"largeFileMode":false}},"tokenizedBuffer":{"deserializer":"TokenizedBuffer","bufferId":"118017ce453321af3b41bd5ece2d8413","tabLength":2,"largeFileMode":false},"displayLayerId":0,"selectionsMarkerLayerId":"3","firstVisibleScreenRow":0,"firstVisibleScreenColumn":0,"atomicSoftTabs":true,"softWrapHangingIndentLength":0,"id":4,"softTabs":true,"softWrapped":false,"softWrapAtPreferredLineLength":false,"preferredLineLength":80,"mini":false,"width":881,"largeFileMode":false,"registered":true,"invisibles":{"eol":"¬","space":"·","tab":"»","cr":"¤"},"showInvisibles":false,"showIndentGuide":false,"autoHeight":false}],"itemStackIndices":[0],"activeItemIndex":0,"focused":false,"flexScale":1},"activePaneId":3},"packagesWithActiveGrammars":["language-hyperlink","language-todo"],"destroyedItemURIs":[]},"packageStates":{"bookmarks":{"4":{"markerLayerId":"4"}},"fuzzy-finder":{},"metrics":{"sessionLength":42118},"tree-view":{"directoryExpansionStates":{},"hasFocus":false,"attached":false,"scrollLeft":0,"scrollTop":0,"width":0}},"grammars":{"grammarOverridesByPath":{}},"fullScreen":false,"windowDimensions":{"x":130,"y":45,"width":918,"height":760,"maximized":false},"textEditors":{"editorGrammarOverrides":{}}}';

registerGetterSetter('temporary-window-state', temporaryWindowState);
registerGetterSetter('window-size');
registerGetterSetter('window-position');
registerMethod('window-method');
registerMethod('show-window');
registerMethod('focus-window');

function dispatch(action, ...args) {
  (listeners[action] || []).forEach(function(listener) {
    listener(action, ...args);
  })
}

module.exports = {
  app: {
    getPath(arg) {
      if (arg === 'home') {
        return require('fs-plus').getHomeDirectory();
      } else {
        console.error(`app.getPath() called with ${arg}: not supported.`);
      }
    },

    getVersion() {
      // TODO: Read this from Atom's package.json.
      return '0.37.8';
    },

    on(eventName, callback) {
      console.error(`Dropping ${eventName} on the floor in Electron.`);
    },

    setAppUserModelId(modelId) {

    },
  },

  ipcRenderer: {
    on(action, cb) {
      if (!listeners[action]) {
        listeners[action] = [];
      }
      listeners[action].push(cb);
      if (action === 'ipc-helpers-get-temporary-window-state-response') {
        dispatch('ipc-helpers-get-temporary-window-state-response', temporaryWindowState);
      }
    },

    send(action, ...args) {
      var handler = handlers[action];
      if (!handler) {
        console.warn('Ignored IPC call', action, ...args);
        return;
      }
      handler(...args)
    },

    sendSync(action, ...args) {
      var handler = handlers[action];
      if (!handler) {
        console.warn('Ignored synchronous IPC call', action, ...args);
        return;
      }
      handler(...args)
    },

    removeAllListeners(action) {
      delete listeners[action];
    },

    removeListener(action, callback) {
      const listenersForAction = listeners[action] || [];
      const index = listenersForAction.indexOf(callback);
      if (index !== -1) {
        listenersForAction.splice(index, 1);
      }
    },
  },

  remote: {
    getCurrentWindow() {
      return {
        on() {},
        isFullScreen() { return false; },
        getPosition() { return [0, 0]; },
        getSize() { return [800, 600]; },
        isMaximized() { return false; },
        isWebViewFocused() { return true; },
        removeListener(action, callback) {
          console.warn(`Failing to remove listener for ${action} in remote.getCurrentWindow().`);
        },
      }
    },

    screen: {
      getPrimaryDisplay() {
        return {
          workAreaSize: {},
        };
      },
    },
  },

  webFrame: {
    setZoomLevelLimits: function() {},
  },

  screen: {
    on() {},
    removeListener(action, callback) {},
  },
};
