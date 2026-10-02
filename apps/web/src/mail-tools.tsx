// SPDX-License-Identifier: LGPL-3.0-only
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Skeleton } from '@socle/ui';
import {
  CalendarView,
  resolveText,
  type CalendarEvent,
  type ThreadNotification,
  type ThreadSource,
} from '@socle/view-engine';
import type { ModelCatalog } from '@socle/framework';
import { Bell, CalendarDays } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export function MailTools({
  source,
  registry,
  language,
  timeZone,
  disabled,
  onOpen,
}: {
  readonly source: ThreadSource;
  readonly registry: ModelCatalog;
  readonly language: string;
  readonly timeZone: string;
  readonly disabled: boolean;
  readonly onOpen: (model: string, id: string, accepted: () => void) => void;
}): React.ReactElement {
  const fr = language.startsWith('fr'),
    ar = language.startsWith('ar');
  const copy = ar
    ? {
        notifications: 'الإشعارات',
        activities: 'أنشطتي',
        description: 'تواريخ استحقاق أنشطتي الشخصية',
        close: 'إغلاق',
        refresh: 'تحديث',
        empty: 'لا توجد إشعارات جديدة.',
        error: 'تعذر تحميل البيانات.',
        message: 'رسالة جديدة',
      }
    : fr
      ? {
          notifications: 'Notifications',
          activities: 'Mes activités',
          description: 'Échéances de mes activités personnelles',
          close: 'Fermer',
          refresh: 'Actualiser',
          empty: 'Aucune nouvelle notification.',
          error: 'Impossible de charger les données.',
          message: 'Nouvel échange',
        }
      : {
          notifications: 'Notifications',
          activities: 'My activities',
          description: 'My personal activity deadlines',
          close: 'Close',
          refresh: 'Refresh',
          empty: 'No new notifications.',
          error: 'Could not load data.',
          message: 'New conversation',
        };
  const [panel, setPanel] = useState<'notifications' | 'activities'>();
  const [notifications, setNotifications] = useState<readonly ThreadNotification[]>();
  const [events, setEvents] = useState<readonly CalendarEvent[]>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const activeRef = useRef(false);
  const versionRef = useRef(0);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      versionRef.current += 1;
    };
  }, []);

  async function load(kind: 'notifications' | 'activities'): Promise<void> {
    const version = ++versionRef.current;
    setBusy(true);
    setFailed(false);
    try {
      if (kind === 'notifications' && source.notifications) {
        const values = await source.notifications();
        if (activeRef.current && version === versionRef.current) setNotifications(values);
      } else if (source.activities) {
        const values = await source.activities();
        if (activeRef.current && version === versionRef.current) setEvents(values);
      }
    } catch {
      if (activeRef.current && version === versionRef.current) setFailed(true);
    } finally {
      if (activeRef.current && version === versionRef.current) setBusy(false);
    }
  }

  return (
    <div className="web-mail-tools">
      {source.notifications ? (
        <Button
          icon={Bell}
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => {
            setPanel('notifications');
            void load('notifications');
          }}
        >
          {copy.notifications}
        </Button>
      ) : null}
      {source.activities ? (
        <Button
          icon={CalendarDays}
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => {
            setPanel('activities');
            void load('activities');
          }}
        >
          {copy.activities}
        </Button>
      ) : null}
      <Dialog.Root
        open={panel !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPanel(undefined);
            versionRef.current += 1;
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="web-dialog-overlay" />
          <Dialog.Content className="web-dialog web-mail-dialog">
            <Dialog.Title>
              {panel === 'notifications' ? copy.notifications : copy.activities}
            </Dialog.Title>
            <Dialog.Description>
              {panel === 'notifications' ? copy.message : copy.description}
            </Dialog.Description>
            <div className="web-mail-actions">
              <Button
                variant="secondary"
                disabled={busy || panel === undefined}
                onClick={() => {
                  if (panel) void load(panel);
                }}
              >
                {copy.refresh}
              </Button>
              <Dialog.Close asChild>
                <Button>{copy.close}</Button>
              </Dialog.Close>
            </div>
            {failed ? <p role="alert">{copy.error}</p> : null}
            {busy ? <Skeleton lines={3} label={copy.refresh} /> : null}
            {!busy && panel === 'notifications' && notifications ? (
              notifications.length === 0 ? (
                <p>{copy.empty}</p>
              ) : (
                <ul>
                  {notifications.map((notification) => (
                    <li key={notification.id}>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          onOpen(notification.model, notification.recordId, () => {
                            setPanel(undefined);
                            if (source.seen)
                              void source.seen(notification.id).catch(() => undefined);
                          });
                        }}
                      >
                        {copy.message} ·{' '}
                        {resolveText(
                          registry.get(notification.model).description,
                          language,
                          notification.model,
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
            {!busy && panel === 'activities' && events ? (
              <CalendarView
                events={events}
                language={language}
                timeZone={timeZone}
                onOpen={(model, id) => {
                  onOpen(model, id, () => {
                    setPanel(undefined);
                  });
                }}
              />
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
