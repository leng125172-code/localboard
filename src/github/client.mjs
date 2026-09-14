import { spawn } from 'node:child_process';

export class GhClient {
  constructor(options = {}) {
    this.executable = options.executable ?? 'gh';
    this.env = options.env ?? process.env;
  }

  async graphql(query, variables = {}) {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [name, value] of Object.entries(variables)) {
      if (value === undefined || value === null) continue;
      args.push(typeof value === 'number' || typeof value === 'boolean' ? '-F' : '-f', `${name}=${value}`);
    }
    return this.runJson(args);
  }

  async rest(method, endpoint, fields = {}) {
    const args = ['api', '--method', method.toUpperCase(), '-H', 'Accept: application/vnd.github+json', endpoint];
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        args.push('-F', `${name}=${value === null ? 'null' : value}`);
      } else if (Array.isArray(value)) {
        for (const item of value) args.push('-f', `${name}[]=${item}`);
      } else {
        args.push('-f', `${name}=${value}`);
      }
    }
    return this.runJson(args);
  }

  runJson(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, { env: this.env, windowsHide: true, shell: false });
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.once('error', reject);
      child.once('close', (code) => {
        const out = Buffer.concat(stdout).toString('utf8').trim();
        const err = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) return reject(new Error(err || `gh exited with code ${code}`));
        try {
          resolve(out ? JSON.parse(out) : {});
        } catch {
          reject(new Error(`gh returned invalid JSON: ${out.slice(0, 200)}`));
        }
      });
    });
  }
}

