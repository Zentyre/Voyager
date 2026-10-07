// Entry point for one crew member's worker thread.

const { workerData, parentPort } = require("worker_threads");
require("./compat").registerExtraVersions();
const { startBot } = require("./bot");
const { createCrewClient } = require("./crew");

startBot(workerData.config, createCrewClient(parentPort, workerData));
