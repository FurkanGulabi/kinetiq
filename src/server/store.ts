/**
 * In-memory application store (was src/server/cnc/lib/ImmutableStore.js + store/index.js, CNCjs).
 *
 * set()/unset()/clear() replace `state` with a new object and emit 'change' with it. The default
 * export is the process-wide singleton holding the open controllers (`controllers[port]`);
 * there must be only one instance.
 */
import _ from 'lodash';
import events from 'events';

export type StoreState = Record<string, unknown>;

/** A dotted / bracketed path string or a path array (lodash), e.g. `controllers["/dev/ttyUSB0"]`. */
export type StoreKey = _.PropertyPath;

export class ImmutableStore extends events.EventEmitter {
    state: StoreState = {};

    constructor(state: StoreState = {}) {
      super();

      this.state = state;
    }

    get<T = unknown>(key: StoreKey, defaultValue?: T): T {
      return _.get(this.state, key, defaultValue) as T;
    }

    set(key: StoreKey, value: unknown): StoreState {
      this.state = _.merge({}, this.state, _.set({}, key, value));
      this.emit('change', this.state);
      return this.state;
    }

    unset(key: StoreKey): StoreState {
      let state: StoreState = _.extend({}, this.state);
      _.unset(state, key);
      this.state = state;
      this.emit('change', this.state);
      return this.state;
    }

    replace(key: StoreKey, value: unknown): void {
      this.unset(key);
      this.set(key, value);
    }

    clear(): StoreState {
      this.state = {};
      this.emit('change', this.state);
      return this.state;
    }
}

const defaultState = {
  controllers: {}
};

const store = new ImmutableStore(defaultState);

export default store;
