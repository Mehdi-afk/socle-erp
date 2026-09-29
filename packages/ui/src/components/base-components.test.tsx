// SPDX-License-Identifier: LGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Mail, Phone, Trash2 } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { accessibilityViolations } from '../testing/axe.js';

import { Avatar, AvatarStack } from './avatar.js';
import { Badge, StatusPill } from './badge.js';
import { Button, IconButton } from './button.js';
import { Card, FieldItem, FieldList } from './card.js';

const noViolations = async (container: Element): Promise<void> => {
  expect(await accessibilityViolations(container)).toEqual([]);
};

const user = userEvent.setup();

describe('Button', () => {
  it('is a button that does not submit, with its text and its variant', async () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button variant="primary" onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('data-variant', 'primary');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    await noViolations(container);
  });

  it('works from the keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await user.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('ignores a click while it is disabled, and while it is running (and says so)', async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    await user.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();

    rerender(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const running = screen.getByRole('button');
    expect(running).toHaveAttribute('aria-busy', 'true');
    // Still focusable: a running button must not make the focus jump elsewhere.
    expect(running).toBeEnabled();
    await user.click(running);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('can submit a form and carry an icon before its text', async () => {
    const onSubmit = vi.fn((event: React.SyntheticEvent) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" icon={Mail}>
          Send
        </Button>
      </form>,
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(document.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps every variant and size accessible', async () => {
    const { container } = render(
      <div>
        {(['primary', 'secondary', 'ghost', 'danger'] as const).map((variant) => (
          <Button key={variant} variant={variant} size="sm">
            {variant}
          </Button>
        ))}
      </div>,
    );
    await noViolations(container);
  });
});

describe('IconButton', () => {
  it('takes its name from its label, and shows it as a tooltip', async () => {
    const onClick = vi.fn();
    const { container } = render(<IconButton icon={Phone} label="Call Amel" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Call Amel' });
    expect(button).toHaveAttribute('title', 'Call Amel');
    expect(button).toHaveAttribute('data-shape', 'round');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    await noViolations(container);
  });

  it('turns a directional icon in right-to-left languages, and only when asked', () => {
    const { rerender } = render(<IconButton icon={Trash2} label="Delete" tone="plain" />);
    expect(document.querySelector('svg')).not.toHaveAttribute('data-flip');
    rerender(<IconButton icon={Trash2} label="Delete" tone="plain" flip />);
    expect(document.querySelector('svg')).toHaveAttribute('data-flip', 'true');
  });
});

describe('Card', () => {
  it('is a named region with its title as a heading and its actions', async () => {
    const { container } = render(
      <Card title="General data" actions={<Button size="sm">Edit</Button>}>
        <p>Content</p>
      </Card>,
    );
    const region = screen.getByRole('region', { name: 'General data' });
    expect(within(region).getByRole('heading', { level: 2, name: 'General data' })).toBeVisible();
    expect(within(region).getByRole('button', { name: 'Edit' })).toBeVisible();
    expect(within(region).getByText('Content')).toBeVisible();
    await noViolations(container);
  });

  it('honours the heading level, the accent tone and a missing title', () => {
    const { rerender } = render(
      <Card title="Confidential" titleLevel="h3" tone="accent">
        x
      </Card>,
    );
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('region')).toHaveAttribute('data-tone', 'accent');
    rerender(<Card>plain</Card>);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});

describe('FieldList', () => {
  it('pairs each label with its value as a description list', async () => {
    const { container } = render(
      <FieldList>
        <FieldItem label="Email">amel@example.test</FieldItem>
        <FieldItem label="Phone">0555 12 34 56</FieldItem>
      </FieldList>,
    );
    const terms = screen.getAllByRole('term').map((node) => node.textContent);
    const values = screen.getAllByRole('definition').map((node) => node.textContent);
    expect(terms).toEqual(['Email', 'Phone']);
    expect(values).toEqual(['amel@example.test', '0555 12 34 56']);
    await noViolations(container);
  });

  it('marks an empty value visually and in words, but not a zero', () => {
    render(
      <FieldList>
        <FieldItem label="City" />
        <FieldItem label="Notes">{''}</FieldItem>
        <FieldItem label="Score">{0}</FieldItem>
        <FieldItem label="Fax" emptyLabel="Aucune valeur">
          {null}
        </FieldItem>
      </FieldList>,
    );
    const values = screen.getAllByRole('definition');
    expect(values[0]).toHaveTextContent('—Not set');
    expect(values[1]).toHaveTextContent('—Not set');
    expect(values[2]).toHaveTextContent('0');
    expect(values[3]).toHaveTextContent('—Aucune valeur');
    expect(within(values[0] as HTMLElement).getByText('—')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Badge and StatusPill', () => {
  it('caps a counter and reads the real number with its meaning', async () => {
    const { container } = render(<Badge count={120} label="unread notifications" />);
    expect(screen.getByText('99+')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('120 unread notifications')).toHaveClass('ui-sr-only');
    await noViolations(container);
  });

  it('shows a counter without a label as plain text', () => {
    render(<Badge count={3} tone="neutral" />);
    expect(screen.getByText('3')).toBeVisible();
  });

  it('never shows a state by colour alone: the dot is decorative, the word is there', async () => {
    const { container } = render(
      <div>
        {(['success', 'warning', 'danger', 'info', 'neutral'] as const).map((tone) => (
          <StatusPill key={tone} tone={tone}>
            {`State ${tone}`}
          </StatusPill>
        ))}
      </div>,
    );
    for (const tone of ['success', 'warning', 'danger', 'info', 'neutral']) {
      expect(screen.getByText(`State ${tone}`)).toBeVisible();
    }
    expect(container.querySelectorAll('.ui-pill-dot[aria-hidden="true"]')).toHaveLength(5);
    await noViolations(container);
  });
});

describe('Avatar', () => {
  it('is an image named after the person, with initials on a category colour', async () => {
    const { container } = render(<Avatar name="Amel Benali" />);
    const avatar = screen.getByRole('img', { name: 'Amel Benali' });
    expect(avatar).toHaveTextContent('AB');
    expect(avatar).toHaveAttribute('data-category');
    // The same name always gets the same colour.
    const again = render(<Avatar name="Amel Benali" />);
    expect(again.container.querySelector('.ui-avatar')).toHaveAttribute(
      'data-category',
      avatar.getAttribute('data-category'),
    );
    await noViolations(container);
  });

  it('shows a photo when there is one, still named after the person', () => {
    render(<Avatar name="Amel Benali" src="/photos/amel.png" size="lg" />);
    const avatar = screen.getByRole('img', { name: 'Amel Benali' });
    expect(avatar.querySelector('img')).toHaveAttribute('src', '/photos/amel.png');
    expect(avatar.querySelector('img')).toHaveAttribute('alt', '');
    expect(avatar).not.toHaveAttribute('data-category');
    expect(avatar).toHaveAttribute('data-size', 'lg');
  });
});

describe('AvatarStack', () => {
  const people = [
    'Amel Benali',
    'Karim Haddad',
    'Sara Mansouri',
    'Yacine Belkacem',
    'Lina Cherif',
  ].map((name) => ({ name }));

  it('lists the first people and summarises the others in a chip that names them', async () => {
    const { container } = render(<AvatarStack people={people} label="Participants" />);
    const list = screen.getByRole('list', { name: 'Participants' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    const chip = screen.getByRole('img', { name: '2: Yacine Belkacem, Lina Cherif' });
    expect(chip).toHaveTextContent('+2');
    expect(chip).toHaveAttribute('title', 'Yacine Belkacem, Lina Cherif');
    await noViolations(container);
  });

  it('has no chip when everyone fits', () => {
    render(<AvatarStack people={people.slice(0, 2)} label="Participants" max={3} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });
});
