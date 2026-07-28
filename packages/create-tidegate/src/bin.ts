#!/usr/bin/env node
import { runCreateTidegate } from "./cli.ts";

const exitCode = await runCreateTidegate(process.argv.slice(2));

process.exit(exitCode);
