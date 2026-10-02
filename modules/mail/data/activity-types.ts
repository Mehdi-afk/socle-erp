// SPDX-License-Identifier: LGPL-3.0-only
import { defineData } from '@socle/framework';

export default defineData('mail.activity.type', [
  { id: 'activity_call', values: { code: 'call', name: 'Appel', color: 1 } },
  { id: 'activity_email', values: { code: 'email', name: 'E-mail', color: 2 } },
  { id: 'activity_meeting', values: { code: 'meeting', name: 'Réunion', color: 3 } },
  { id: 'activity_todo', values: { code: 'todo', name: 'À faire', color: 4 } },
]);
