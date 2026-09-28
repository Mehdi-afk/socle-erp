// SPDX-License-Identifier: LGPL-3.0-only
export { parseCommand, USAGE, UsageError } from './args.js';
export type { Command, ParsedArgs } from './args.js';
export { CommandError } from './commands.js';
export type { Context, Output } from './commands.js';
export { ConfigError, readConfig } from './config.js';
export type { CliConfig } from './config.js';
export { main } from './main.js';
export type { Io } from './main.js';
export { planInstall, planUninstall, planUpgrade, PlanError } from './plan.js';
export type { InstallPlan, UninstallPlan, UpgradePlan } from './plan.js';
export { scaffoldModule, ScaffoldError } from './scaffold.js';
