// SPDX-License-Identifier: LGPL-3.0-only
import { SocleError } from '@socle/framework';

/**
 * The PostgreSQL schema cannot be derived from the models, or cannot be changed automatically
 * (a destructive change needs a hand-written migration, ARCHITECTURE.md §4.7).
 */
export class SchemaError extends SocleError {
  constructor(message: string) {
    super('orm_pg.schema', message);
  }
}
