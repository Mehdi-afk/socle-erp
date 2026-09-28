// SPDX-License-Identifier: LGPL-3.0-only
//
// acc_ext extends a model of acc_base: a new field on acc.partner.
import { extendModel, f } from '@socle/framework';

export default extendModel('acc.partner', { fields: { vip: f.boolean() } });
