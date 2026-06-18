'use client';

import { useEffect, useRef } from 'react';
import { useCrmStore } from '@/store/useCrmStore';
import { isToday, isPast } from 'date-fns';

const STORAGE_KEY = 'crm-notified-tasks';
const LAST_CHECK_KEY = 'crm-last-notif-check';

function getNotifiedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveNotifiedSet(set: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {}
}

function shouldCheck(): boolean {
  try {
    const last = localStorage.getItem(LAST_CHECK_KEY);
    if (!last) return true;
    // Only check once per 6 hours
    return Date.now() - parseInt(last) > 6 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

function markChecked() {
  localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
}

export default function NotificationManager() {
  const { contacts } = useCrmStore();
  const hasCheckedRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (contacts.length === 0 || hasCheckedRef.current) return;
    if (!shouldCheck()) { hasCheckedRef.current = true; return; }

    // Request permission if needed
    if (Notification.permission === 'default') {
      Notification.requestPermission();
      return;
    }
    if (Notification.permission !== 'granted') return;

    hasCheckedRef.current = true;

    const timeout = setTimeout(() => {
      const notified = getNotifiedSet();
      const overdue: string[] = [];
      const dueToday: string[] = [];

      const allTasks = contacts.flatMap(c =>
        c.tasks
          .filter(t => !t.completed && t.due_date)
          .map(t => ({ ...t, contactName: c.name }))
      );

      for (const task of allTasks) {
        const taskDate = new Date(task.due_date + 'T23:59:59');
        if (notified.has(task.id)) continue;

        if (isToday(new Date(task.due_date + 'T12:00:00'))) {
          dueToday.push(`${task.title} (${task.contactName})`);
          notified.add(task.id);
        } else if (isPast(taskDate)) {
          overdue.push(`${task.title} (${task.contactName})`);
          notified.add(task.id);
        }
      }

      // Send ONE batched notification per category
      if (overdue.length > 0) {
        new Notification(`${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}`, {
          body: overdue.slice(0, 3).join('\n') + (overdue.length > 3 ? `\n+${overdue.length - 3} more` : ''),
          icon: '/favicon.svg',
          tag: 'crm-overdue',
        });
      }

      if (dueToday.length > 0) {
        new Notification(`${dueToday.length} task${dueToday.length > 1 ? 's' : ''} due today`, {
          body: dueToday.slice(0, 3).join('\n') + (dueToday.length > 3 ? `\n+${dueToday.length - 3} more` : ''),
          icon: '/favicon.svg',
          tag: 'crm-today',
        });
      }

      if (overdue.length > 0 || dueToday.length > 0) {
        saveNotifiedSet(notified);
      }
      markChecked();
    }, 5000);

    return () => clearTimeout(timeout);
  }, [contacts]);

  return null;
}
