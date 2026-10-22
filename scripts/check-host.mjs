// `npm run check:host` — the real-Host contract gate for this plugin.
//
// The upgrade gate (T0047) runs one command per repository and passes one
// environment variable: `DSH_HOST_ROOT`, the staged Host's `dsh-plugin-desktop`
// directory. Nothing else is read from the environment on the gate's behalf;
// this script maps that single value onto the variable this repository's older
// contract files already use (`DSH_RUNTIME_ROOT`), so the gate never has to
// know about it.
//
//   DSH_HOST_ROOT=…\.build\desktop\dsh-plugin-desktop npm run check:host
//
// Without `DSH_HOST_ROOT` every case reports NOT EXECUTED and the exit code is
// 1: a leg with no Host is a leg that proved nothing, and must not read as a
// pass. For local use only, `DSH_HOST_ROOTS` takes several roots separated by
// `;` or `,` and runs the whole set in one go.
//
// The case list is `test/test_cases.csv`: the numbered, described cases are the
// contract, and this runner reports per case id so a red line names the case
// rather than a file. One child process at a time, `--test-concurrency=1` — the
// cases boot real Hosts and a parallel run exhausts memory on a developer
// machine.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases } from './run-functional-cases.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The contract files `check:host` owns. Every case in `test_cases.csv` that
 * points at one of these is a real-Host case, and nothing else in the suite is.
 */
export const HOST_CONTRACT_FILES = Object.freeze([
    'scripts/verify-host-contracts.mjs',
    'scripts/verify-credential-catalog-refresh.mjs',
    'scripts/verify-adapter-pricing.mjs',
    'scripts/verify-composer-model-menu.mjs',
]);

/**
 * The Host roots to run against.
 * @returns absolute roots in run order; empty when the gate named none.
 */
function hostRoots() {
    const many = process.env.DSH_HOST_ROOTS;
    const one = process.env.DSH_HOST_ROOT ?? process.env.DSH_RUNTIME_ROOT;
    const raw = many !== undefined && many.trim() !== '' ? many.split(/[;,]/u) : [one];
    return raw.map((value) => value?.trim()).filter((value) => value !== undefined && value !== '');
}

/**
 * Run one contract file and read each case's verdict out of its TAP output.
 * @param file - repo-relative contract file.
 * @param env - the child environment, already carrying the Host root.
 * @returns `{ statuses, exitCode, stderr }`; statuses key on the test name.
 */
function runContractFile(file, env) {
    const child = spawnSync(
        process.execPath,
        ['--test', '--test-concurrency=1', '--test-reporter=tap', join(ROOT, file)],
        { cwd: ROOT, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 },
    );
    if (child.error) throw child.error;
    const statuses = new Map();
    const reasons = new Map();
    for (const line of child.stdout.split(/\r?\n/u)) {
        // `ok 3 - <name> # SKIP <reason>`: the directive and its reason ride the
        // same line as the verdict, so the reason a case states for not running
        // reaches the report.
        const verdict = line.match(
            /^\s*(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO)(?:\s+(.*))?)?$/u,
        );
        if (!verdict) continue;
        const [, outcome, name, directive, reason] = verdict;
        const key = name.trim();
        statuses.set(key, directive ? 'not-executed' : outcome === 'ok' ? 'passed' : 'failed');
        if (reason !== undefined && reason.trim() !== '') reasons.set(key, reason.trim());
    }
    return { statuses, reasons, exitCode: child.status ?? 1, stderr: child.stderr };
}

/**
 * Run the contract suite against one Host.
 * @param root - the staged Host's `dsh-plugin-desktop` directory.
 * @param cases - the CSV cases that belong to the contract files.
 * @returns the per-case results and the child exit codes.
 */
function checkOneHost(root, cases) {
    // One value in, two names out: the files added for T0047 read
    // DSH_HOST_ROOT, the three that predate it read DSH_RUNTIME_ROOT. The gate
    // only ever sets the former.
    const env = { ...process.env, DSH_HOST_ROOT: root, DSH_RUNTIME_ROOT: root };
    delete env.DSH_HOST_ROOTS;
    const statuses = new Map();
    const reasons = new Map();
    const runs = [];
    for (const file of HOST_CONTRACT_FILES) {
        if (!existsSync(join(ROOT, file))) {
            runs.push({ file, exitCode: 1, missing: true });
            continue;
        }
        const result = runContractFile(file, env);
        for (const [name, status] of result.statuses) statuses.set(`${file} :: ${name}`, status);
        for (const [name, reason] of result.reasons) reasons.set(`${file} :: ${name}`, reason);
        runs.push({ file, exitCode: result.exitCode, stderr: result.stderr });
    }
    const results = cases.map((testCase) => {
        const verdicts = testCase.references.map((reference) => {
            const key = `${reference.file} :: ${reference.name}`;
            return { key, status: statuses.get(key) ?? 'missing', reason: reasons.get(key) };
        });
        const worst = verdicts.some(({ status }) => status === 'failed')
            ? 'failed'
            : verdicts.some(({ status }) => status === 'missing')
              ? 'missing'
              : verdicts.some(({ status }) => status === 'not-executed')
                ? 'not-executed'
                : 'passed';
        return {
            id: testCase.用例编号,
            title: testCase.用例标题,
            result: worst,
            reason: verdicts.find((verdict) => verdict.reason)?.reason,
            verdicts,
        };
    });
    return { root, results, runs };
}

/**
 * Whether a skipped case was skipped because this Host LINE lacks the surface,
 * rather than because the run was not set up.
 *
 * Fails closed: a contract file states a line limitation with a reason that
 * begins `NOT EXECUTED on DSH <version>`, and anything else — no reason, a
 * missing Host root, unreachable dependencies — counts as a failed check. That
 * way a case can never quietly stop running, while a case that genuinely has no
 * counterpart on an older line does not keep the gate permanently red.
 * @param reason - the skip reason the contract file reported.
 * @returns true when the skip is a stated per-line gap.
 */
function statedLineGap(reason) {
    return typeof reason === 'string' && /^NOT EXECUTED on DSH\s+\S+/u.test(reason);
}

/** `passed 23, not executed on this line 6, failed 0` for one Host's results. */
function tally(results) {
    const count = (result) => results.filter((entry) => entry.result === result).length;
    const lineGaps = results.filter(
        (entry) => entry.result === 'not-executed' && statedLineGap(entry.reason),
    ).length;
    return [
        `passed ${count('passed')}`,
        `not executed on this Host line ${lineGaps}`,
        `not executed without a reason ${count('not-executed') - lineGaps}`,
        `failed ${count('failed')}`,
        `no result ${count('missing')}`,
    ].join(', ');
}

export function main() {
    const cases = loadCases(readFileSync(join(ROOT, 'test', 'test_cases.csv'), 'utf8')).filter(
        (testCase) =>
            testCase.references.length > 0 &&
            testCase.references.every(({ file }) => HOST_CONTRACT_FILES.includes(file)),
    );
    if (cases.length === 0) {
        console.error('check:host found no real-Host cases in test/test_cases.csv');
        process.exitCode = 1;
        return;
    }
    const roots = hostRoots();
    if (roots.length === 0) {
        // The explicit, loud form of "this proved nothing".
        console.error('DSH_HOST_ROOT is not set: the real-Host contract cases were NOT EXECUTED.');
        console.error("Set it to a staged Host's dsh-plugin-desktop directory, for example:");
        console.error(
            '  DSH_HOST_ROOT=...\\.build\\desktop\\dsh-plugin-desktop npm run check:host',
        );
        for (const testCase of cases) {
            console.error(`  ${testCase.用例编号} NOT EXECUTED — ${testCase.用例标题}`);
        }
        console.error(`${cases.length} cases NOT EXECUTED; this is a failed check, not a pass.`);
        process.exitCode = 1;
        return;
    }
    let failed = false;
    for (const root of roots) {
        console.log(`\n=== DSH_HOST_ROOT ${root}`);
        if (!existsSync(join(root, 'package.json'))) {
            console.error(`  not a staged Host: no package.json under ${root}`);
            failed = true;
            continue;
        }
        const { results, runs } = checkOneHost(root, cases);
        for (const entry of results) {
            const label =
                entry.result === 'passed'
                    ? 'PASS'
                    : entry.result === 'not-executed'
                      ? statedLineGap(entry.reason)
                          ? 'NOT EXECUTED (this Host line)'
                          : 'NOT EXECUTED'
                      : entry.result === 'missing'
                        ? 'NO RESULT'
                        : 'FAIL';
            const because = entry.reason === undefined ? '' : ` — ${entry.reason}`;
            console.log(`  ${entry.id} ${label}: ${entry.title}${because}`);
        }
        console.log(`  ${tally(results)}`);
        for (const run of runs) {
            if (run.missing) console.error(`  missing contract file: ${run.file}`);
        }
        const fatal = results.filter(
            (entry) =>
                entry.result === 'failed' ||
                entry.result === 'missing' ||
                (entry.result === 'not-executed' && !statedLineGap(entry.reason)),
        );
        if (fatal.length > 0 || runs.some((run) => run.missing)) failed = true;
    }
    if (failed) {
        console.error('\ncheck:host failed: see the cases marked FAIL or NOT EXECUTED above.');
        process.exitCode = 1;
    } else {
        console.log(`\ncheck:host passed: ${cases.length} cases on ${roots.length} Host(s).`);
    }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
