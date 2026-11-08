import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { OrgUnit, Substation, TapLateral, TapNode, TrunkLine } from '@/domain/types';
import type { PersonalDraft } from '@/lib/personalDrafts';

interface PowerMapDB extends DBSchema {
  meta: { key: string; value: unknown };
  substations: { key: string; value: Substation };
  lines: { key: string; value: TrunkLine };
  tapNodes: { key: string; value: TapNode };
  tapLaterals: { key: string; value: TapLateral };
  orgUnits: { key: string; value: OrgUnit };
  personalDrafts: { key: string; value: PersonalDraft };
}

type StoreName = 'substations' | 'lines' | 'tapNodes' | 'tapLaterals' | 'orgUnits';

let dbPromise: Promise<IDBPDatabase<PowerMapDB>> | null = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<PowerMapDB>('powermap-dro-v2', 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('meta');
          db.createObjectStore('substations', { keyPath: 'id' });
          db.createObjectStore('lines', { keyPath: 'id' });
          db.createObjectStore('tapNodes', { keyPath: 'id' });
          db.createObjectStore('tapLaterals', { keyPath: 'id' });
          db.createObjectStore('orgUnits', { keyPath: 'id' });
        }
        if (oldVersion < 2 && !db.objectStoreNames.contains('personalDrafts')) {
          db.createObjectStore('personalDrafts', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

export async function idbGetAll<T extends StoreName>(store: T): Promise<PowerMapDB[T]['value'][]> {
  const db = await getDb();
  return db.getAll(store);
}

export async function idbPut<T extends StoreName>(store: T, value: PowerMapDB[T]['value']) {
  const db = await getDb();
  await db.put(store, value as never);
}

export async function idbDelete(store: StoreName, id: string) {
  const db = await getDb();
  await db.delete(store, id);
}

export async function idbGetMeta<T = unknown>(key: string): Promise<T | undefined> {
  const db = await getDb();
  return (await db.get('meta', key)) as T | undefined;
}

export async function idbSetMeta(key: string, value: unknown) {
  const db = await getDb();
  await db.put('meta', value, key);
}

export async function idbClearAll() {
  const db = await getDb();
  await Promise.all([
    db.clear('substations'),
    db.clear('lines'),
    db.clear('tapNodes'),
    db.clear('tapLaterals'),
    db.clear('orgUnits'),
  ]);
}

export async function idbReplaceAll(data: {
  substations: Substation[];
  lines: TrunkLine[];
  tapNodes: TapNode[];
  tapLaterals: TapLateral[];
  orgUnits: OrgUnit[];
}) {
  const db = await getDb();
  const tx = db.transaction(
    ['substations', 'lines', 'tapNodes', 'tapLaterals', 'orgUnits'],
    'readwrite',
  );
  await Promise.all([
    tx.objectStore('substations').clear(),
    tx.objectStore('lines').clear(),
    tx.objectStore('tapNodes').clear(),
    tx.objectStore('tapLaterals').clear(),
    tx.objectStore('orgUnits').clear(),
  ]);
  await Promise.all([
    ...data.substations.map((s) => tx.objectStore('substations').put(s)),
    ...data.lines.map((l) => tx.objectStore('lines').put(l)),
    ...data.tapNodes.map((t) => tx.objectStore('tapNodes').put(t)),
    ...data.tapLaterals.map((t) => tx.objectStore('tapLaterals').put(t)),
    ...data.orgUnits.map((o) => tx.objectStore('orgUnits').put(o)),
  ]);
  await tx.done;
}
