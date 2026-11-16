#!/usr/bin/env node
// Local owner management service entry. User workflows are in the Dots page.
import { workspaceOwnerMain } from '../dist/automation/production/workspaceOwnerMain.mjs';
await workspaceOwnerMain(process.argv.slice(2));
