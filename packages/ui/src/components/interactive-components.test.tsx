// SPDX-License-Identifier: LGPL-3.0-only
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Inbox, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { accessibilityViolations } from '../testing/axe.js';

import { Button, IconButton } from './button.js';
import { EmptyState, Skeleton } from './feedback.js';
import { Checkbox, SelectField, Switch, TextField } from './inputs.js';
import { ActionMenu } from './menu.js';
import { UiProvider } from './provider.js';
import { SegmentedControl } from './segmented.js';
import { Tabs } from './tabs.js';
import { Tooltip } from './tooltip.js';

const user = userEvent.setup();
const none = async (element: Element): Promise<void> => {
  expect(await accessibilityViolations(element)).toEqual([]);
};

const sections = [
  { id: 'general', label: 'General', content: <p>General data</p> },
  { id: 'address', label: 'Address', content: <p>Address data</p> },
  { id: 'legal', label: 'Legal', content: <p>Legal data</p>, disabled: true },
  { id: 'notes', label: 'Notes', content: <p>Notes data</p> },
] as const;

describe('Tabs', () => {
  it('names the list, selects the first tab and shows its panel', async () => {
    const { container } = render(<Tabs label="Contact sections" items={sections} />);
    const list = screen.getByRole('tablist', { name: 'Contact sections' });
    expect(within(list).getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('General data');
    await none(container);
  });

  it('switches on click and on arrow keys, skipping a disabled tab, Home and End included', async () => {
    const onValueChange = vi.fn();
    render(<Tabs label="Sections" items={sections} onValueChange={onValueChange} />);
    await user.click(screen.getByRole('tab', { name: 'Address' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Address data');
    await user.keyboard('{ArrowRight}');
    // "Legal" is disabled: the next tab is "Notes".
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Notes data');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveFocus();
    expect(onValueChange).toHaveBeenLastCalledWith('notes');
    await user.click(screen.getByRole('tab', { name: 'Legal' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Notes data');
  });

  it('follows the reading direction: in Arabic the left arrow goes to the next tab', async () => {
    render(
      <UiProvider dir="rtl">
        <div dir="rtl">
          <Tabs label="Sections" items={sections} />
        </div>
      </UiProvider>,
    );
    await user.click(screen.getByRole('tab', { name: 'General' }));
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Address' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();
  });

  it('can be controlled by its parent', () => {
    const { rerender } = render(<Tabs label="Sections" items={sections} value="address" />);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Address data');
    rerender(<Tabs label="Sections" items={sections} value="notes" />);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Notes data');
  });
});

describe('Tooltip', () => {
  it('appears on keyboard focus, is read as the description, and goes away on Escape', async () => {
    render(
      <UiProvider>
        <Tooltip content="Call Amel">
          <IconButton icon={Pencil} label="Phone" />
        </Tooltip>
      </UiProvider>,
    );
    await user.tab();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Call Amel');
    expect(screen.getByRole('button', { name: 'Phone' })).toHaveAccessibleDescription('Call Amel');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });

  it('appears on hover as well', async () => {
    render(
      <UiProvider>
        <Tooltip content="Print" side="bottom">
          <Button>Report</Button>
        </Tooltip>
      </UiProvider>,
    );
    await user.hover(screen.getByRole('button', { name: 'Report' }));
    expect(await screen.findByRole('tooltip', undefined, { timeout: 2000 })).toHaveTextContent(
      'Print',
    );
  });
});

describe('ActionMenu', () => {
  const build = (onDelete = vi.fn(), onEdit = vi.fn()) => (
    <UiProvider>
      <ActionMenu
        label="More actions"
        items={[
          { id: 'edit', label: 'Edit', icon: Pencil, onSelect: onEdit },
          'separator',
          { id: 'delete', label: 'Delete', icon: Trash2, tone: 'danger', onSelect: onDelete },
          { id: 'archive', label: 'Archive', onSelect: vi.fn(), disabled: true },
        ]}
      />
    </UiProvider>
  );

  it('opens from its named button, lists the actions and runs the chosen one', async () => {
    const onEdit = vi.fn();
    render(build(vi.fn(), onEdit));
    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Edit', 'Delete', 'Archive']);
    expect(within(menu).getByRole('separator')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'data-tone',
      'danger',
    );
    await none(document.body);
    await user.click(within(menu).getByRole('menuitem', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  it('works from the keyboard, closes on Escape and returns the focus to its button', async () => {
    const onDelete = vi.fn();
    render(build(onDelete));
    const trigger = screen.getByRole('button', { name: 'More actions' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onDelete).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();

    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('does not run a disabled action', async () => {
    const onEdit = vi.fn();
    render(build(vi.fn(), onEdit));
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const archive = await screen.findByRole('menuitem', { name: 'Archive' });
    expect(archive).toHaveAttribute('aria-disabled', 'true');
    await user.click(archive);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe('SegmentedControl', () => {
  const options = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
  ] as const;

  it('is a named group of radios with the current one selected', async () => {
    const { container } = render(
      <SegmentedControl label="Calendar view" options={options} value="week" onChange={vi.fn()} />,
    );
    expect(screen.getByRole('group', { name: 'Calendar view' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Week' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Day' })).not.toBeChecked();
    await none(container);
  });

  it('reports the choice made by click and by arrow keys', async () => {
    const onChange = vi.fn();
    function Harness(): React.ReactElement {
      const [value, setValue] = useState<'day' | 'week' | 'month'>('day');
      return (
        <SegmentedControl
          label="Calendar view"
          options={options}
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    await user.click(screen.getByText('Month'));
    expect(onChange).toHaveBeenLastCalledWith('month');
    expect(screen.getByRole('radio', { name: 'Month' })).toBeChecked();
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('week');
    expect(screen.getByRole('radio', { name: 'Week' })).toBeChecked();
  });
});

describe('form fields', () => {
  it('tie the label, the hint and the error to the field', async () => {
    const { container } = render(
      <TextField
        label="Email"
        type="email"
        hint="We never share it."
        error="Enter a valid address."
        required
        defaultValue="amel"
      />,
    );
    const field = screen.getByLabelText('Email', { exact: false });
    expect(field).toBeRequired();
    expect(field).toBeInvalid();
    expect(field).toHaveAccessibleDescription('We never share it. Enter a valid address.');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid address.');
    // The asterisk is decoration: the field is announced as required by its attribute.
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
    await none(container);
  });

  it('are valid and undescribed by default, and can be typed into or disabled', async () => {
    render(
      <>
        <TextField label="Name" />
        <TextField label="Locked" disabled />
      </>,
    );
    const name = screen.getByLabelText('Name');
    expect(name).toBeValid();
    expect(name).not.toHaveAttribute('aria-describedby');
    await user.type(name, 'Amel');
    expect(name).toHaveValue('Amel');
    expect(screen.getByLabelText('Locked')).toBeDisabled();
  });

  it('let a select offer a first empty choice and report the selection', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <SelectField
        label="Country"
        placeholder="Choose…"
        options={[
          { value: 'dz', label: 'Algeria' },
          { value: 'fr', label: 'France' },
        ]}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />,
    );
    const select = screen.getByLabelText('Country');
    expect(select).toHaveValue('');
    await user.selectOptions(select, 'France');
    expect(onChange).toHaveBeenLastCalledWith('fr');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await none(container);
  });

  it('give a checkbox and a switch their own roles and states', async () => {
    const { container } = render(
      <>
        <Checkbox label="Subscribed" hint="Newsletter" />
        <Switch label="Active" defaultChecked />
      </>,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Subscribed' });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAccessibleDescription('Newsletter');
    await user.click(screen.getByText('Subscribed'));
    expect(checkbox).toBeChecked();
    const toggle = screen.getByRole('switch', { name: 'Active' });
    expect(toggle).toBeChecked();
    await user.keyboard('{Tab}{Tab}');
    await none(container);
  });
});

describe('EmptyState and Skeleton', () => {
  it('say what is missing and offer the way out', async () => {
    const { container } = render(
      <EmptyState
        icon={Inbox}
        title="No contact yet"
        action={<Button variant="primary">Add a contact</Button>}
      >
        Contacts you add will appear here.
      </EmptyState>,
    );
    expect(screen.getByText('No contact yet')).toBeVisible();
    expect(screen.getByText('Contacts you add will appear here.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add a contact' })).toBeVisible();
    await none(container);
  });

  it('announce that content is loading while showing only decorative bars', async () => {
    const { container } = render(<Skeleton lines={4} label="Loading contacts" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading contacts');
    expect(container.querySelectorAll('.ui-skeleton-line[aria-hidden="true"]')).toHaveLength(4);
    await none(container);
  });
});
