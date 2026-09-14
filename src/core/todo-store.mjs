import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { emptyTodoFile, normalizeTodoFile } from './model.mjs';
import { withDirectoryLock } from './file-lock.mjs';

export class TodoStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async read() {
    try {
      return normalizeTodoFile(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyTodoFile();
      throw error;
    }
  }

  async mutate(mutator) {
    return withDirectoryLock(this.filePath, async () => {
      const current = await this.read();
      const result = await mutator(current);
      const next = normalizeTodoFile(result.file ?? result);
      await this.writeAtomic(next);
      return { file: next, value: result.value };
    });
  }

  async writeAtomic(value) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, this.filePath);
  }
}
