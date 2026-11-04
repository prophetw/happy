#!/usr/bin/env node
import { automationWorkerMain, automationMetadataMain } from '../dist/daemon/automationMain.mjs';
try {
    const args = process.argv.slice(2);
    if (args[0] === '--preflight') process.stdout.write(JSON.stringify(await automationMetadataMain(args.slice(1))) + '\n');
    else await automationWorkerMain(args);
}
catch { process.stderr.write('Happy automation worker startup rejected; no login or grant was created.\n'); process.exitCode = 1; }
