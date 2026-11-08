// SECURITY (Kinetiq): taskRunner.run() spawns a shell. Its only callers are the EventTrigger
// callbacks in CNCEngine and GrblController, and the commands they pass come from the `events`
// entries of the rc file (~/.kinetiqrc), which only the machine owner can edit.
// Never pass socket, HTTP or other frontend input to run(), and never add an API that writes
// `events` (or any other value later handed to run()) into the config. The future Automation UI
// must use a fixed allow-list of server-defined actions instead. See ../../README.md.
import TaskRunner from './TaskRunner';

const taskRunner = new TaskRunner();

export default taskRunner;
