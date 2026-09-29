// SPDX-License-Identifier: LGPL-3.0-only
import { Eye, EyeOff, Inbox, Mail, Pencil, Phone, Printer } from 'lucide-react';
import { useState } from 'react';

import {
  ActionMenu,
  Avatar,
  AvatarStack,
  Badge,
  Button,
  Card,
  Checkbox,
  contrastPairs,
  contrastRatio,
  CATEGORY_COUNT,
  deriveAccent,
  EmptyState,
  FieldItem,
  FieldList,
  IconButton,
  scale,
  SegmentedControl,
  SelectField,
  Skeleton,
  StatusPill,
  Switch,
  Tabs,
  TextField,
  themes,
  Tooltip,
  type CategoryToken,
  type ColorToken,
  type ThemeName,
} from '../src/index.js';

import type { Copy } from './copy.js';

interface SectionProps {
  readonly copy: Copy;
}

function Section({
  title,
  children,
  id,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly id: string;
}): React.ReactElement {
  return (
    <section className="guide-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="guide-heading">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** One colour: a chip filled from the token, its CSS name and its value. */
function Swatch({
  token,
  value,
}: {
  readonly token: ColorToken;
  readonly value: string;
}): React.ReactElement {
  const cssName = `--color-${token.replace(/[A-Z]|\d+/g, (part) => `-${part.toLowerCase()}`)}`;
  return (
    <figure className="guide-swatch">
      <div className="guide-swatch-chip" style={{ '--swatch': value } as React.CSSProperties} />
      <figcaption>
        <code>{cssName}</code>
        <span>{value}</span>
      </figcaption>
    </figure>
  );
}

export function ColorsSection({
  copy,
  theme,
}: SectionProps & { readonly theme: ThemeName }): React.ReactElement {
  const colors = themes[theme];
  const surfaces: ColorToken[] = [
    'canvas',
    'shell',
    'shellText',
    'shellMuted',
    'surface',
    'surfaceSunken',
  ];
  const content: ColorToken[] = [
    'ink',
    'label',
    'line',
    'link',
    'accent',
    'onAccent',
    'accentSoft',
    'navActive',
    'onNavActive',
  ];
  const categories = Array.from(
    { length: CATEGORY_COUNT },
    (_, index) => `category${String(index + 1)}` as CategoryToken,
  );
  const semantic = (['success', 'warning', 'danger', 'info'] as const).flatMap((name) => [
    name,
    `${name}Soft` as ColorToken,
    `${name}Text` as ColorToken,
  ]);
  return (
    <Section id="colors" title={copy.colors}>
      <div className="guide-swatches">
        {[...surfaces, ...content].map((token) => (
          <Swatch key={token} token={token} value={colors[token]} />
        ))}
      </div>
      <h3 className="guide-subheading">{copy.categories}</h3>
      <div className="guide-swatches">
        {categories.map((token) => (
          <Swatch key={token} token={token} value={colors[token]} />
        ))}
      </div>
      <h3 className="guide-subheading">{copy.semantic}</h3>
      <div className="guide-swatches">
        {semantic.map((token) => (
          <Swatch key={token} token={token} value={colors[token]} />
        ))}
      </div>
    </Section>
  );
}

export function ContrastSection({
  copy,
  theme,
}: SectionProps & { readonly theme: ThemeName }): React.ReactElement {
  const colors = themes[theme];
  const rows = contrastPairs(theme).map((pair) => {
    const ratio = contrastRatio(colors[pair.foreground], colors[pair.background]);
    return { ...pair, ratio, ok: ratio + 1e-9 >= pair.minimum };
  });
  return (
    <Section id="contrast" title={copy.contrast}>
      <p className="guide-note">{copy.contrastHelp}</p>
      <Card>
        <div className="guide-table-scroll">
          <table className="guide-table">
            <caption className="ui-sr-only">{copy.contrast}</caption>
            <thead>
              <tr>
                <th scope="col">{copy.pair}</th>
                <th scope="col">{copy.ratio}</th>
                <th scope="col">{copy.required}</th>
                <th scope="col">{copy.states}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.foreground}-${row.background}`}>
                  <td>
                    <span
                      className="guide-pair-sample"
                      style={
                        {
                          '--foreground': colors[row.foreground],
                          '--background': colors[row.background],
                        } as React.CSSProperties
                      }
                      aria-hidden="true"
                    >
                      Aa
                    </span>{' '}
                    {row.use}
                  </td>
                  <td>{row.ratio.toFixed(2)} : 1</td>
                  <td>{row.minimum} : 1</td>
                  <td>
                    <StatusPill tone={row.ok ? 'success' : 'danger'}>
                      {row.ok ? copy.passes : copy.fails}
                    </StatusPill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Section>
  );
}

export function TypographySection({ copy }: SectionProps): React.ReactElement {
  return (
    <Section id="typography" title={copy.typography}>
      <Card>
        <p className="guide-type-title">{copy.person}</p>
        <p className="guide-type-heading">{copy.generalData}</p>
        <p className="guide-type-body">{copy.intro}</p>
        <p className="guide-type-label">{copy.email}</p>
        <p className="guide-type-small">{copy.states}</p>
        <p className="guide-type-numbers">1 234 567,89 · 0123456789 · ٠١٢٣٤٥٦٧٨٩</p>
      </Card>
    </Section>
  );
}

export function ShapesSection({ copy }: SectionProps): React.ReactElement {
  return (
    <Section id="shapes" title={copy.shapes}>
      <Card>
        <div className="guide-shapes">
          <div className="guide-shape" data-shape="card">
            {scale.radiusCard}
          </div>
          <div className="guide-shape" data-shape="field">
            {scale.radiusField}
          </div>
          <div className="guide-shape" data-shape="pill">
            {scale.radiusPill}
          </div>
        </div>
        <div className="guide-spaces" aria-hidden="true">
          {scale.space.slice(1).map((px) => (
            <span
              key={px}
              className="guide-space"
              style={{ '--size': `${String(px)}px` } as React.CSSProperties}
            />
          ))}
        </div>
        <FieldList>
          <FieldItem label={copy.name}>{copy.person}</FieldItem>
          <FieldItem label={copy.city}>Alger</FieldItem>
        </FieldList>
      </Card>
    </Section>
  );
}

export function ButtonsSection({ copy }: SectionProps): React.ReactElement {
  return (
    <Section id="buttons" title={copy.buttons}>
      <Card>
        <div className="guide-row">
          <Button variant="primary">{copy.primary}</Button>
          <Button variant="secondary">{copy.secondary}</Button>
          <Button variant="ghost">{copy.ghost}</Button>
          <Button variant="danger">{copy.danger}</Button>
        </div>
        <div className="guide-row">
          <Button variant="primary" size="sm">
            {copy.primary}
          </Button>
          <Button variant="primary" loading>
            {copy.running}
          </Button>
          <Button variant="secondary" disabled>
            {copy.disabled}
          </Button>
          <Button variant="primary" icon={Mail}>
            {copy.message}
          </Button>
        </div>
        <div className="guide-row">
          <Tooltip content={copy.call}>
            <IconButton icon={Phone} label={copy.call} />
          </Tooltip>
          <Tooltip content={copy.message}>
            <IconButton icon={Mail} label={copy.message} />
          </Tooltip>
          <Tooltip content={copy.print}>
            <IconButton icon={Printer} label={copy.print} />
          </Tooltip>
          <Tooltip content={copy.edit}>
            <IconButton icon={Pencil} label={copy.edit} tone="plain" />
          </Tooltip>
        </div>
      </Card>
    </Section>
  );
}

export function CardsSection({ copy }: SectionProps): React.ReactElement {
  const [shown, setShown] = useState(false);
  return (
    <Section id="cards" title={copy.cards}>
      <div className="guide-columns">
        <Card
          title={copy.generalData}
          actions={
            <>
              <IconButton icon={Pencil} label={copy.edit} tone="plain" size="sm" />
              <ActionMenu
                label={copy.moreActions}
                items={[
                  { id: 'edit', label: copy.edit, icon: Pencil, onSelect: () => undefined },
                  { id: 'archive', label: copy.archive, onSelect: () => undefined },
                  'separator',
                  { id: 'delete', label: copy.delete, tone: 'danger', onSelect: () => undefined },
                ]}
              />
            </>
          }
        >
          <FieldList>
            <FieldItem label={copy.name}>{copy.person}</FieldItem>
            <FieldItem label={copy.email}>amel@example.test</FieldItem>
            <FieldItem label={copy.phone}>0555 12 34 56</FieldItem>
            <FieldItem label={copy.city} />
          </FieldList>
        </Card>
        <Card
          tone="accent"
          title={copy.confidentialData}
          actions={
            <Button
              size="sm"
              variant="secondary"
              icon={shown ? EyeOff : Eye}
              onClick={() => {
                setShown((value) => !value);
              }}
              aria-pressed={shown}
            >
              {copy.show}
            </Button>
          }
        >
          <FieldList>
            <FieldItem label={copy.taxId}>
              {shown ? '000 123 456 789 012' : '••••••••••••••'}
            </FieldItem>
            <FieldItem label={copy.bankAccount}>
              {shown ? '00799999 0012345678 12' : '••••••••••••••'}
            </FieldItem>
          </FieldList>
        </Card>
      </div>
    </Section>
  );
}

export function BadgesSection({ copy }: SectionProps): React.ReactElement {
  const people = [{ name: copy.person }, ...copy.others.map((name) => ({ name }))];
  return (
    <Section id="badges" title={copy.badges}>
      <Card>
        <div className="guide-row">
          <Badge count={3} />
          <Badge count={12} tone="neutral" />
          <Badge count={120} label="notifications" />
        </div>
        <div className="guide-row">
          <StatusPill tone="success">{copy.active}</StatusPill>
          <StatusPill tone="warning">{copy.states} 1</StatusPill>
          <StatusPill tone="danger">{copy.danger}</StatusPill>
          <StatusPill tone="info">{copy.sample}</StatusPill>
          <StatusPill tone="neutral">{copy.disabled}</StatusPill>
        </div>
        <div className="guide-row">
          <Avatar name={copy.person} size="sm" />
          <Avatar name={copy.person} />
          <Avatar name={copy.others[0] ?? ''} size="lg" />
          <AvatarStack people={people} label={copy.participants} />
        </div>
      </Card>
    </Section>
  );
}

export function NavigationSection({ copy }: SectionProps): React.ReactElement {
  const [view, setView] = useState<'day' | 'week' | 'month'>('week');
  return (
    <Section id="navigation" title={copy.navigation}>
      <Tabs
        label={copy.sections}
        items={[
          { id: 'general', label: copy.tabGeneral, content: <p>{copy.generalData}</p> },
          { id: 'address', label: copy.tabAddress, content: <p>{copy.city}</p> },
          { id: 'notes', label: copy.tabNotes, content: <p>{copy.notes}</p> },
        ]}
      />
      <SegmentedControl
        label={copy.view}
        value={view}
        onChange={setView}
        options={[
          { value: 'day', label: copy.day },
          { value: 'week', label: copy.week },
          { value: 'month', label: copy.month },
        ]}
      />
    </Section>
  );
}

export function FieldsSection({ copy }: SectionProps): React.ReactElement {
  return (
    <Section id="fields" title={copy.fields}>
      <Card>
        <div className="guide-form">
          <TextField label={copy.name} defaultValue={copy.person} required />
          <TextField
            label={copy.email}
            type="email"
            defaultValue="amel@"
            hint={copy.emailHint}
            error={copy.emailError}
          />
          <SelectField
            label={copy.country}
            placeholder={copy.choose}
            options={[
              { value: 'dz', label: 'Algérie / Algeria' },
              { value: 'fr', label: 'France' },
            ]}
          />
          <TextField label={copy.disabled} disabled defaultValue="—" />
          <Checkbox label={copy.subscribed} defaultChecked />
          <Switch label={copy.active} defaultChecked />
        </div>
      </Card>
    </Section>
  );
}

export function FeedbackSection({ copy }: SectionProps): React.ReactElement {
  return (
    <Section id="feedback" title={copy.feedback}>
      <div className="guide-columns">
        <Card>
          <EmptyState
            icon={Inbox}
            title={copy.noContact}
            action={<Button variant="primary">{copy.addContact}</Button>}
          >
            {copy.noContactText}
          </EmptyState>
        </Card>
        <Card>
          <Skeleton label={copy.loading} lines={4} />
        </Card>
      </div>
    </Section>
  );
}

export function FocusSection({ copy }: SectionProps): React.ReactElement {
  return (
    <Section id="focus" title={copy.focus}>
      <p className="guide-note">{copy.focusText}</p>
      <div className="guide-focus">
        {(['canvas', 'shell', 'surface', 'accent', 'nav'] as const).map((background) => (
          <div key={background} className="guide-focus-box" data-background={background}>
            <Button variant="ghost">{background}</Button>
          </div>
        ))}
      </div>
    </Section>
  );
}

export function AccentSection({
  copy,
  value,
  onChange,
}: SectionProps & {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): React.ReactElement {
  const checked = deriveAccent(value);
  return (
    <Section id="accent" title={copy.accent}>
      <p className="guide-note">{copy.accentHelp}</p>
      <Card>
        <div className="guide-form">
          <TextField
            label={copy.accent}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        {checked.ok ? (
          <div className="guide-row">
            <StatusPill tone="success">{copy.accentAccepted}</StatusPill>
            <Button variant="primary">{copy.textOnAccent}</Button>
            <Badge count={7} />
            <span>
              {copy.ratio}: {checked.ratios.onAccent?.toFixed(1)} : 1
            </span>
          </div>
        ) : (
          <div>
            <StatusPill tone="danger">{copy.accentRefused}</StatusPill>
            <ul className="guide-reasons">
              {checked.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </Section>
  );
}
