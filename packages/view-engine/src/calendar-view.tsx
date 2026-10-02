// SPDX-License-Identifier: LGPL-3.0-only
import { Button, SelectField, TextField } from '@socle/ui';
import { useState } from 'react';

import { calendarDays, moveCalendar } from './calendar-days.js';
import { activityTypeName } from './thread-copy.js';
import type { CalendarEvent } from './types.js';
import './calendar-view.css';

export interface CalendarViewProps {
  readonly events: readonly CalendarEvent[];
  readonly language: string;
  readonly timeZone: string;
  readonly onOpen: (model: string, id: string) => void;
}

/** Whole-day deadlines rendered for any module, with week/month navigation and category filters. */
export function CalendarView({
  events,
  language,
  timeZone,
  onOpen,
}: CalendarViewProps): React.ReactElement {
  const ar = language.startsWith('ar'),
    fr = language.startsWith('fr');
  const copy = ar
    ? {
        previous: 'السابق',
        next: 'التالي',
        view: 'العرض',
        week: 'أسبوع',
        month: 'شهر',
        date: 'التاريخ',
        category: 'نوع النشاط',
        all: 'الكل',
        empty: 'لا توجد أنشطة',
        total: 'الأنشطة',
      }
    : fr
      ? {
          previous: 'Précédent',
          next: 'Suivant',
          view: 'Période',
          week: 'Semaine',
          month: 'Mois',
          date: 'Date du calendrier',
          category: 'Type d’activité',
          all: 'Tous',
          empty: 'Aucune activité',
          total: 'activités',
        }
      : {
          previous: 'Previous',
          next: 'Next',
          view: 'Period',
          week: 'Week',
          month: 'Month',
          date: 'Calendar date',
          category: 'Activity type',
          all: 'All',
          empty: 'No activities',
          total: 'activities',
        };
  const [day, setDay] = useState(() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    return ['year', 'month', 'day']
      .map((part) => parts.find((item) => item.type === part)?.value)
      .join('-');
  });
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [category, setCategory] = useState('');
  const days = calendarDays(day, mode);
  const visible = events.filter((event) => !category || event.typeCode === category);
  const categories = [...new Map(events.map((event) => [event.typeCode, event])).values()];
  const format = new Intl.DateTimeFormat(language, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const count = visible.filter((event) => days.includes(event.dueDate)).length;
  return (
    <div className="ve-calendar">
      <div className="ve-calendar-toolbar">
        <Button
          variant="secondary"
          onClick={() => {
            setDay(moveCalendar(day, mode, -1));
          }}
        >
          {copy.previous}
        </Button>
        <TextField
          type="date"
          label={copy.date}
          value={day}
          onChange={(event) => {
            if (event.target.value && event.target.validity.valid) setDay(event.target.value);
          }}
        />
        <Button
          variant="secondary"
          onClick={() => {
            setDay(moveCalendar(day, mode, 1));
          }}
        >
          {copy.next}
        </Button>
        <SelectField
          label={copy.view}
          value={mode}
          options={[
            { value: 'week', label: copy.week },
            { value: 'month', label: copy.month },
          ]}
          onChange={(event) => {
            setMode(event.target.value === 'month' ? 'month' : 'week');
          }}
        />
        <SelectField
          label={copy.category}
          value={category}
          options={[
            { value: '', label: copy.all },
            ...categories.map((event) => ({
              value: event.typeCode,
              label: activityTypeName(event.typeCode, event.typeName, language),
            })),
          ]}
          onChange={(event) => {
            setCategory(event.target.value);
          }}
        />
      </div>
      <p role="status">
        {new Intl.NumberFormat(language).format(count)} {copy.total}
      </p>
      <div className="ve-calendar-days">
        {days.map((date) => (
          <section
            key={date}
            className="ve-calendar-day"
            aria-label={format.format(new Date(`${date}T12:00:00Z`))}
          >
            <h3>
              <time dateTime={date}>{format.format(new Date(`${date}T12:00:00Z`))}</time>
            </h3>
            <ul>
              {visible
                .filter((event) => event.dueDate === date)
                .map((event) => (
                  <li key={event.id}>
                    <button
                      type="button"
                      className="ve-calendar-event"
                      data-color={event.color}
                      onClick={() => {
                        onOpen(event.resModel, event.resId);
                      }}
                    >
                      <strong dir="auto">{event.summary}</strong>
                      <span>{activityTypeName(event.typeCode, event.typeName, language)}</span>
                    </button>
                  </li>
                ))}
            </ul>
            {visible.some((event) => event.dueDate === date) ? null : (
              <p className="ve-calendar-empty">{copy.empty}</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
