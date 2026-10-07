// Entry point for one crew member's worker thread.

const { workerData, parentPort } = require("worker_threads");
require("./compat").registerExtraVersions();
const { startBot } = require("./bot");
const { createCrewClient } = require("./crew");

// Status and log lines go to the coordinator's dashboard.
const reporter = {
    status: (status) => parentPort.postMessage({ type: "status", status }),
    log: (line) => parentPort.postMessage({ type: "log", line }),
};
startBot(workerData.config, createCrewClient(parentPort, workerData), reporter);
