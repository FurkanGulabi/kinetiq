/**
 * Kinetiq backend settings (was src/server/cnc/config/settings.js).
 *
 * The subset of CNCjs config/settings.{base,development,production}.js that the GRBL backend reads.
 * NODE_ENV must be set before this module is first required: `env` and `winston.level` are
 * computed once, when the module evaluates. src/server/backend.ts mutates `rcfile` and `secret`.
 */
import os from 'os';
import path from 'path';

export interface Settings {
  env: string;
  rcfile: string;
  verbosity: number;
  secret: string;
  accessTokenLifetime: string;
  allowRemoteAccess: boolean;
  winston: {
    level: string;
  };
}

const env = process.env.NODE_ENV || 'production'; // Ensure production environment if empty

const settings: Settings = {
  env: env,

  // Overwritten by src/server/backend.ts (KINETIQ_RC or ~/.kinetiqrc)
  rcfile: path.resolve(os.homedir(), '.kinetiqrc'),
  verbosity: 0,

  // The secret key is loaded from the config file (see src/server/backend.ts)
  secret: '',

  // Access Token Lifetime
  accessTokenLifetime: '30d', // https://github.com/zeit/ms

  // Allow Remote Access
  allowRemoteAccess: false,

  winston: {
    // https://github.com/winstonjs/winston#logging-levels
    level: (env === 'development') ? 'debug' : 'info'
  }
};

export default settings;
