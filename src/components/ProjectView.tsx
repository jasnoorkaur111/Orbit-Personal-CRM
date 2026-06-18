'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Check, Clock, Trash2, UserPlus, Plus, X, Archive, RotateCcw, Pencil, Calendar, CheckSquare, Users } from 'lucide-react';
import { useCrmStore, Project } from '@/store/useCrmStore';
import { useToastStore } from '@/components/Toast';
import { format, isPast, isToday } from 'date-fns';

type TaskType = 'follow-up' | 'send' | 'meeting' | 'other';
const typeLabels: Record<TaskType, { label: string; color: string }> = {
  'follow-up': { label: 'Follow-up', color: '#6C5CE7' },
  send: { label: 'Send', color: '#4285F4' },
  meeting: { label: 'Meeting', color: '#00C9A7' },
  other: { label: 'Other', color: '#71717A' },
};

interface ProjectViewProps {
  projectId: string;
  onBack: () => void;
}

export default function ProjectView({ projectId, onBack }: ProjectViewProps) {
  const { projects, contacts, events, updateProject, deleteProject, removeContactFromProject, addContactToProject, toggleTask, deleteTask, setSelectedContact, addTask } = useCrmStore();
  const addToast = useToastStore((s) => s.addToast);

  const project = projects.find((p) => p.id === projectId);
  const [showAddContact, setShowAddContact] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  // Task creation — defaults to self so the user can add tasks for themselves
  // without first promoting a contact. Tasks still need a contact_id in DB,
  // so self acts as the "personal task" carrier.
  const [showAddTask, setShowAddTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskType, setTaskType] = useState<TaskType>('follow-up');
  const [taskDue, setTaskDue] = useState('');
  const [taskAssigneeId, setTaskAssigneeId] = useState<string>('');

  if (!project) return <div className="p-6 text-center text-[var(--text-secondary)]">Project not found</div>;

  const projectContacts = contacts.filter((c) => project.contactIds.includes(c.id));
  const projectTasks = contacts.flatMap((c) =>
    c.tasks.filter((t) => t.project_id === projectId).map((t) => ({
      ...t, contactName: c.name, contactColor: c.color || '#6c63ff', contactId: c.id,
    }))
  );
  const pendingTasks = projectTasks.filter((t) => !t.completed);
  const completedTasks = projectTasks.filter((t) => t.completed);

  const now = new Date();
  const projectEvents = events.filter((e) => e.project_id === projectId && new Date(e.date + 'T23:59:59') >= now);

  const availableContacts = contacts.filter(
    (c) => !project.contactIds.includes(c.id) && c.name.toLowerCase().includes(contactSearch.toLowerCase())
  );

  const startEdit = () => {
    setEditName(project.name);
    setEditDesc(project.description || '');
    setEditing(true);
  };

  const saveEdit = () => {
    if (editName.trim()) {
      updateProject(project.id, { name: editName.trim(), description: editDesc.trim() || undefined });
    }
    setEditing(false);
  };

  const selfContact = contacts.find((c) => (c as any).is_self);
  // Tasks need a contact_id — default to self so personal tasks work.
  // Project contacts are offered too so the user can assign a task to a person in the project.
  const taskAssignees = selfContact
    ? [{ id: selfContact.id, name: 'Me', color: selfContact.color || '#7c5cff' }, ...projectContacts.map((c) => ({ id: c.id, name: c.name, color: c.color || '#6c63ff' }))]
    : projectContacts.map((c) => ({ id: c.id, name: c.name, color: c.color || '#6c63ff' }));

  const saveTask = async () => {
    const title = taskTitle.trim();
    if (!title) return;
    const assigneeId = taskAssigneeId || selfContact?.id || projectContacts[0]?.id;
    if (!assigneeId) {
      addToast({ message: 'Add a contact to the project first, or sign in so we can attach tasks to you', type: 'error' });
      return;
    }
    await addTask({
      contact_id: assigneeId,
      title,
      type: taskType,
      due_date: taskDue || undefined,
      project_id: project.id,
    });
    addToast({ message: 'Task added', type: 'success', icon: 'task' });
    setTaskTitle('');
    setTaskDue('');
    setTaskAssigneeId('');
    setTaskType('follow-up');
    setShowAddTask(false);
  };

  return (
    <div className="h-full p-3 md:p-6 overflow-y-auto pb-24 md:pb-6">
      <div className="max-w-3xl mx-auto">
        {/* Back + Header */}
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors mb-4">
          <ArrowLeft size={14} /> All projects
        </button>

        <div className="flex items-start justify-between mb-6">
          <div className="flex-1 min-w-0">
            {editing ? (
              <div className="space-y-2">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                  className="w-full text-xl md:text-2xl font-bold bg-transparent border-b border-[var(--accent)] focus:outline-none pb-1"
                  autoFocus
                />
                <input
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                  placeholder="Add a description..."
                  className="w-full text-sm text-[var(--text-secondary)] bg-transparent border-b border-[var(--border)] focus:outline-none focus:border-[var(--accent)] pb-1"
                />
                <div className="flex gap-2">
                  <button onClick={saveEdit} className="text-xs px-3 py-1 rounded-lg bg-[var(--accent)] text-white">Save</button>
                  <button onClick={() => setEditing(false)} className="text-xs px-3 py-1 rounded-lg text-[var(--text-secondary)]">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2.5">
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: project.color || '#6c63ff' }} />
                  <h1 className="text-xl md:text-2xl font-bold truncate">{project.name}</h1>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                    project.status === 'active' ? 'bg-[var(--teal)]/15 text-[var(--teal)]' : 'bg-[var(--text-secondary)]/15 text-[var(--text-secondary)]'
                  }`}>
                    {project.status}
                  </span>
                </div>
                {project.description && (
                  <p className="text-sm text-[var(--text-secondary)] mt-1 ml-5">{project.description}</p>
                )}
              </>
            )}
          </div>
          {!editing && (
            <div className="flex items-center gap-1">
              <button onClick={startEdit} className="p-2 hover:bg-[var(--hover-bg)] rounded-lg transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)] btn-press shimmer-hover">
                <Pencil size={14} />
              </button>
              <button
                onClick={() => {
                  updateProject(project.id, { status: project.status === 'active' ? 'archived' : 'active' });
                  addToast({ message: project.status === 'active' ? 'Project archived' : 'Project restored', type: 'info', icon: 'contact' });
                }}
                className="p-2 hover:bg-[var(--hover-bg)] rounded-lg transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)] btn-press shimmer-hover"
                title={project.status === 'active' ? 'Archive' : 'Restore'}
              >
                {project.status === 'active' ? <Archive size={14} /> : <RotateCcw size={14} />}
              </button>
            </div>
          )}
        </div>

        {/* Stats bar */}
        <div className="flex gap-4 mb-6 text-xs text-[var(--text-secondary)]">
          <span className="flex items-center gap-1.5"><Users size={12} /> {projectContacts.length} contacts</span>
          <span className="flex items-center gap-1.5"><CheckSquare size={12} /> {pendingTasks.length} pending</span>
          <span className="flex items-center gap-1.5"><Calendar size={12} /> {projectEvents.length} upcoming</span>
        </div>

        {/* ── Contacts ── */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] flex items-center gap-2">
              <Users size={12} /> Contacts ({projectContacts.length})
            </h2>
            <button
              onClick={() => setShowAddContact(!showAddContact)}
              className="text-[10px] text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors flex items-center gap-1"
            >
              <UserPlus size={12} /> Add
            </button>
          </div>

          {/* Add contact picker */}
          <AnimatePresence>
            {showAddContact && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden mb-3">
                <div className="glass rounded-xl p-3">
                  <input
                    value={contactSearch}
                    onChange={(e) => setContactSearch(e.target.value)}
                    placeholder="Search contacts..."
                    className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[var(--accent)] mb-2"
                    autoFocus
                  />
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {availableContacts.slice(0, 10).map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          addContactToProject(project.id, c.id);
                          addToast({ message: `Added ${c.name} to project`, type: 'success', icon: 'contact' });
                          setContactSearch('');
                        }}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--hover-bg)] rounded-lg transition-colors shimmer-hover flex items-center gap-2"
                      >
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: c.color || '#6c63ff' }} />
                        <span>{c.name}</span>
                        {c.company && <span className="text-[var(--text-secondary)]">- {c.company}</span>}
                      </button>
                    ))}
                    {availableContacts.length === 0 && (
                      <p className="text-xs text-[var(--text-secondary)] text-center py-2">No contacts to add</p>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Contact cards */}
          <div className="space-y-2">
            {projectContacts.map((c) => (
              <div key={c.id} className="flex items-center gap-3 glass-card shimmer-hover p-3 group">
                <button onClick={() => setSelectedContact(c.id)} className="flex items-center gap-2.5 flex-1 min-w-0 text-left">
                  {c.photo ? (
                    <img src={c.photo} alt="" className="w-8 h-8 rounded-full object-cover" />
                  ) : (
                    <span className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ backgroundColor: c.color || '#6c63ff' }}>
                      {c.name.charAt(0)}
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    <p className="text-[10px] text-[var(--text-secondary)] truncate">{c.company || c.role || ''}</p>
                  </div>
                </button>
                <div className="flex items-center gap-1">
                  {c.tasks.filter((t) => !t.completed && t.project_id === projectId).length > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)]">
                      {c.tasks.filter((t) => !t.completed && t.project_id === projectId).length} tasks
                    </span>
                  )}
                  <button
                    onClick={() => {
                      removeContactFromProject(project.id, c.id);
                      addToast({ message: `Removed ${c.name}`, type: 'info', icon: 'delete' });
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1.5 hover:text-red-400 transition-all"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            ))}
            {projectContacts.length === 0 && (
              <p className="text-xs text-[var(--text-secondary)] text-center py-4">No contacts in this project yet</p>
            )}
          </div>
        </section>

        {/* ── Tasks ── */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] flex items-center gap-2">
              <CheckSquare size={12} /> Tasks ({pendingTasks.length} pending)
            </h2>
            <button
              onClick={() => setShowAddTask(!showAddTask)}
              className="text-[10px] text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors flex items-center gap-1"
            >
              <Plus size={12} /> Add
            </button>
          </div>

          <AnimatePresence>
            {showAddTask && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden mb-3">
                <div className="glass rounded-xl p-3 space-y-2">
                  <input
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveTask(); }}
                    placeholder="What needs to happen?"
                    className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[var(--accent)]"
                    autoFocus
                  />
                  <div className="flex flex-wrap gap-2 text-[10px]">
                    <select
                      value={taskAssigneeId || selfContact?.id || ''}
                      onChange={(e) => setTaskAssigneeId(e.target.value)}
                      className="bg-[var(--input-bg)] border border-[var(--border)] rounded-md px-2 py-1.5 focus:outline-none focus:border-[var(--accent)]"
                    >
                      {taskAssignees.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                    <select
                      value={taskType}
                      onChange={(e) => setTaskType(e.target.value as TaskType)}
                      className="bg-[var(--input-bg)] border border-[var(--border)] rounded-md px-2 py-1.5 focus:outline-none focus:border-[var(--accent)]"
                    >
                      {(Object.keys(typeLabels) as TaskType[]).map((t) => (
                        <option key={t} value={t}>{typeLabels[t].label}</option>
                      ))}
                    </select>
                    <input
                      type="date"
                      value={taskDue}
                      onChange={(e) => setTaskDue(e.target.value)}
                      className="bg-[var(--input-bg)] border border-[var(--border)] rounded-md px-2 py-1.5 focus:outline-none focus:border-[var(--accent)]"
                    />
                    <div className="ml-auto flex gap-2">
                      <button onClick={() => { setShowAddTask(false); setTaskTitle(''); setTaskDue(''); }} className="px-2 py-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
                      <button onClick={saveTask} disabled={!taskTitle.trim()} className="px-3 py-1.5 rounded-md bg-[var(--accent)] text-white disabled:opacity-40">Save</button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="space-y-2">
            {pendingTasks.map((task) => (
              <motion.div key={task.id} layout className="flex items-center gap-2 md:gap-3 glass-card shimmer-hover p-3 group">
                <button
                  onClick={() => {
                    toggleTask(task.id, true);
                    addToast({ message: `Completed: ${task.title}`, type: 'success', icon: 'task' });
                  }}
                  className="w-6 h-6 rounded-full border-2 border-[var(--accent)] hover:bg-[var(--accent)] flex items-center justify-center flex-shrink-0 transition-colors"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm">{task.title}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <button onClick={() => setSelectedContact(task.contactId)} className="text-xs flex items-center gap-1 hover:text-[var(--accent)] transition-colors" style={{ color: task.contactColor }}>
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: task.contactColor }} />
                      {task.contactName}
                    </button>
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: typeLabels[task.type as TaskType]?.color + '18', color: typeLabels[task.type as TaskType]?.color }}>
                      {typeLabels[task.type as TaskType]?.label || task.type}
                    </span>
                    {task.due_date && (
                      <span className={`text-xs flex items-center gap-1 ${isPast(new Date(task.due_date + 'T23:59:59')) && !isToday(new Date(task.due_date + 'T12:00:00')) ? 'text-red-400' : 'text-[var(--text-secondary)]'}`}>
                        <Clock size={10} />
                        {format(new Date(task.due_date + 'T12:00:00'), 'MMM d')}
                      </span>
                    )}
                  </div>
                </div>
                <button onClick={() => { deleteTask(task.id); addToast({ message: 'Deleted task', type: 'info', icon: 'delete' }); }} className="opacity-0 group-hover:opacity-100 p-1.5 hover:text-red-400 transition-all">
                  <Trash2 size={14} />
                </button>
              </motion.div>
            ))}
            {completedTasks.length > 0 && (
              <p className="text-[10px] text-[var(--text-secondary)] pt-1">{completedTasks.length} completed</p>
            )}
            {projectTasks.length === 0 && (
              <p className="text-xs text-[var(--text-secondary)] text-center py-4">No tasks in this project</p>
            )}
          </div>
        </section>

        {/* ── Upcoming Events ── */}
        {projectEvents.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] flex items-center gap-2 mb-3">
              <Calendar size={12} /> Upcoming Events ({projectEvents.length})
            </h2>
            <div className="space-y-2">
              {projectEvents.slice(0, 10).map((event) => (
                <div key={event.id} className="glass-card shimmer-hover p-3 text-sm">
                  <p className="font-medium">{event.title}</p>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                    {format(new Date(event.date + 'T12:00:00'), 'EEE, MMM d')}
                    {event.time && ` at ${event.time}`}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Delete project */}
        <div className="border-t border-[var(--border)] pt-6 mt-8">
          <button
            onClick={() => {
              deleteProject(project.id);
              addToast({ message: 'Project deleted', type: 'info', icon: 'delete' });
              onBack();
            }}
            className="text-xs text-red-400 hover:text-red-300 transition-colors"
          >
            Delete project permanently
          </button>
        </div>
      </div>
    </div>
  );
}
