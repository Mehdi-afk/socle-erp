// SPDX-License-Identifier: LGPL-3.0-only
import { extendView, field } from '@socle/framework';

export default extendView('acc_base.partner_form', [
  { at: "group[name='main'] > field[name='city']", position: 'after', node: field('vip') },
]);
