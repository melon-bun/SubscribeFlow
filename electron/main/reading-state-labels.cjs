'use strict';

const DEFAULT_READING_STATE_NAMES = Object.freeze({read: '还会再看', archived: '看完了'});
const DEFERRED_READING_STATE_NAME = '稍后阅读';

class ReadingStateLabels {
  constructor() {
    this.names = {...DEFAULT_READING_STATE_NAMES};
  }

  apply(names) {
    for (const id of Object.keys(DEFAULT_READING_STATE_NAMES)) {
      const value = names && typeof names[id] === 'string' ? names[id].trim() : '';
      this.names[id] = value || DEFAULT_READING_STATE_NAMES[id];
    }
    return {...this.names};
  }

  label(id) {
    return id === 'deferred' ? DEFERRED_READING_STATE_NAME : this.names[id];
  }
}

module.exports = {ReadingStateLabels, DEFAULT_READING_STATE_NAMES, DEFERRED_READING_STATE_NAME};
