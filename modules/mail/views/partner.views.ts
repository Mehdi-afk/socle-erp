// SPDX-License-Identifier: LGPL-3.0-only
import { extendView, node, page } from '@socle/framework';

export default extendView('base.partner_form', [
  {
    at: 'form',
    position: 'inside',
    nodes: [
      node('notebook', {}, [
        page('activity', { fr: 'Activité', en: 'Activity', ar: 'النشاط' }, [node('chatter')]),
      ]),
    ],
  },
]);
