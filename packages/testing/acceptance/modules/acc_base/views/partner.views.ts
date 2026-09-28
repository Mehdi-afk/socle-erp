// SPDX-License-Identifier: LGPL-3.0-only
import { defineView, field, form, group } from '@socle/framework';

export default defineView({
  id: 'acc_base.partner_form',
  model: 'acc.partner',
  type: 'form',
  arch: form([group({ name: 'main' }, [field('name'), field('city'), field('score')])]),
});
