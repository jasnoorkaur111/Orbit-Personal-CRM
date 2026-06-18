import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { loadContactDedupSets } from '@/lib/contactDedup';
import { isNoiseEmail } from '@/lib/noiseEmails';
import { requireAuth } from '@/lib/routeAuth';

const COLORS = [
  '#6c63ff', '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4',
  '#feca57', '#ff9ff3', '#54a0ff', '#5f27cd', '#00d2d3',
];

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth.user.id;

  const formData = await request.formData();
  const file = formData.get('file') as File;
  if (!file) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  try {
    const text = await file.text();
    const lines = text.split('\n').filter(l => l.trim());

    if (lines.length < 2) {
      return NextResponse.json({ error: 'CSV file is empty' }, { status: 400 });
    }

    // Parse header
    const header = lines[0].toLowerCase();
    const headerCols = parseCSVLine(header);

    // LinkedIn CSV columns: First Name, Last Name, Email Address, Company, Position, Connected On, URL
    const firstNameIdx = headerCols.findIndex(h => h.includes('first name'));
    const lastNameIdx = headerCols.findIndex(h => h.includes('last name'));
    const emailIdx = headerCols.findIndex(h => h.includes('email'));
    const companyIdx = headerCols.findIndex(h => h.includes('company'));
    const positionIdx = headerCols.findIndex(h => h.includes('position'));
    const urlIdx = headerCols.findIndex(h => h.includes('url'));

    if (firstNameIdx === -1 && lastNameIdx === -1) {
      // Try generic name column
      const nameIdx = headerCols.findIndex(h => h.includes('name'));
      if (nameIdx === -1) {
        return NextResponse.json({ error: 'Could not find name columns in CSV' }, { status: 400 });
      }
    }

    // Alias-aware dedup
    const { existingEmails, selfEmails, deletedEmails } = await loadContactDedupSets(supabase, userId);
    const { data: existingByName } = await supabase
      .from('contacts').select('name').eq('user_id', userId);
    const existingNames = new Set((existingByName || []).map(c => c.name?.toLowerCase()).filter(Boolean));
    const baseCount = existingNames.size;

    let imported = 0;
    let skipped = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 2) { skipped++; continue; }

      let name = '';
      if (firstNameIdx !== -1 && lastNameIdx !== -1) {
        name = `${cols[firstNameIdx] || ''} ${cols[lastNameIdx] || ''}`.trim();
      } else {
        const nameIdx = headerCols.findIndex(h => h.includes('name'));
        name = cols[nameIdx] || '';
      }

      if (!name) { skipped++; continue; }

      const email = (emailIdx !== -1 ? cols[emailIdx]?.trim() : undefined)?.toLowerCase();
      const company = companyIdx !== -1 ? cols[companyIdx]?.trim() : undefined;
      const role = positionIdx !== -1 ? cols[positionIdx]?.trim() : undefined;
      const linkedin = urlIdx !== -1 ? cols[urlIdx]?.trim() : undefined;

      // Dedup: skip self, noise, then existing
      if (email && selfEmails.has(email)) { skipped++; continue; }
      if (email && isNoiseEmail(email)) { skipped++; continue; }
      if (email && deletedEmails.has(email)) { skipped++; continue; }
      if (existingNames.has(name.toLowerCase())) { skipped++; continue; }
      if (email && existingEmails.has(email)) { skipped++; continue; }

      const color = COLORS[(imported + baseCount) % COLORS.length];

      await supabase.from('contacts').insert({
        user_id: userId,
        name,
        email: email || null,
        company: company || null,
        role: role || null,
        linkedin: linkedin || null,
        notes: '',
        tags: [],
        is_promoted: false,
        color,
      });

      imported++;
      existingNames.add(name.toLowerCase());
      if (email) existingEmails.add(email);
    }

    return NextResponse.json({ imported, skipped, total: lines.length - 1 });
  } catch (error: any) {
    console.error('LinkedIn CSV import error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}
