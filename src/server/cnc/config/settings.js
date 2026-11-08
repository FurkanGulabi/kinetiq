// Kinetiq backend settings: the subset of CNCjs config/settings.{base,development,production}.js
// that the GRBL backend reads. NODE_ENV must be set before this module is first required.
import os from 'os';
import path from 'path';

const env = process.env.NODE_ENV || 'production'; // Ensure production environment if empty

export default {
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
