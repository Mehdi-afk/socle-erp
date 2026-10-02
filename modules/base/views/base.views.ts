// SPDX-License-Identifier: LGPL-3.0-only
//
// Generic views of the base models; the web client (lot 2.3) renders them with the visual
// direction of docs/design/direction-visuelle.md. Other modules extend them with extendView.
import { defineView, field, form, group, list, notebook, page } from '@socle/framework';

export default [
  defineView({
    id: 'base.company_form',
    model: 'res.company',
    type: 'form',
    arch: form([
      group({ name: 'main' }, [
        field('name'),
        field('parentId'),
        field('currencyId'),
        field('countryId'),
        field('tz'),
      ]),
      notebook([
        page('address', { fr: 'Adresse', en: 'Address', ar: 'العنوان' }, [
          group({ name: 'address' }, [
            field('street'),
            field('zip'),
            field('city'),
            field('stateId'),
            field('email', { widget: 'email' }),
            field('phone', { widget: 'phone' }),
          ]),
        ]),
        page('legal', { fr: 'Identifiants légaux', en: 'Legal', ar: 'المعرفات القانونية' }, [
          group({ name: 'legal' }, [field('companyRegistry'), field('vat')]),
        ]),
      ]),
    ]),
  }),
  defineView({
    id: 'base.company_list',
    model: 'res.company',
    type: 'list',
    arch: list([field('name'), field('parentId'), field('currencyId'), field('countryId')]),
  }),
  defineView({
    id: 'base.partner_form',
    model: 'res.partner',
    type: 'form',
    arch: form([
      group({ name: 'main' }, [
        field('name'),
        field('kind'),
        field('email', { widget: 'email' }),
        field('phone', { widget: 'phone' }),
      ]),
      group({ name: 'address' }, [
        field('street'),
        field('street2'),
        field('zip'),
        field('city'),
        field('stateId'),
        field('countryId'),
      ]),
    ]),
  }),
  defineView({
    id: 'base.partner_list',
    model: 'res.partner',
    type: 'list',
    arch: list([
      field('name'),
      field('email', { widget: 'email' }),
      field('phone', { widget: 'phone' }),
      field('city'),
    ]),
  }),
  defineView({
    id: 'base.users_form',
    model: 'res.users',
    type: 'form',
    arch: form([
      group({ name: 'main' }, [
        field('name'),
        field('login'),
        field('email', { widget: 'email' }),
        field('lang'),
      ]),
      notebook([
        page('access', { fr: 'Accès', en: 'Access', ar: 'الوصول' }, [
          group({ name: 'access' }, [field('companyId'), field('companyIds'), field('groupIds')]),
        ]),
      ]),
    ]),
  }),
  defineView({
    id: 'base.users_list',
    model: 'res.users',
    type: 'list',
    arch: list([field('name'), field('login'), field('companyId')]),
  }),
  defineView({
    id: 'base.currency_list',
    model: 'res.currency',
    type: 'list',
    arch: list([field('code'), field('name'), field('decimals'), field('active')]),
  }),
  defineView({
    id: 'base.country_list',
    model: 'res.country',
    type: 'list',
    arch: list([field('code'), field('name')]),
  }),
  defineView({
    id: 'base.config_parameter_list',
    model: 'ir.config_parameter',
    type: 'list',
    arch: list([field('key'), field('value'), field('companyId')]),
  }),
];
