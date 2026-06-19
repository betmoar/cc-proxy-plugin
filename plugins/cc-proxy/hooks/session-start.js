#!/usr/bin/env node
// @ts-check
import { ensureProxyRunning } from "./proxy-lifecycle.js";

ensureProxyRunning()
	.catch(() => {})
	.finally(() => process.exit(0));
