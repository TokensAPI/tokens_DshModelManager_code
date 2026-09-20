import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSV_PATH = path.join(ROOT, 'test', 'test_cases.csv');
const DEFAULT_REPORT = path.join(ROOT, 'test-output', 'functional-cases-latest.json');
const REQUIRED_HEADERS = [
    '用例编号',
    '所属模块',
    '用例标题',
    '前置条件',
    '测试数据',
    '操作步骤',
    '预期结果',
    '优先级',
    '自动化状态',
    '对应测试',
];
const VALID_AUTOMATION = new Set(['已自动化', '部分自动化', '待自动化', '人工验收']);

export function parseCsv(source) {
    const text = source.replace(/^\uFEFF/, '');
    const records = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
            if (char === '"' && text[index + 1] === '"') {
                field += '"';
                index += 1;
            } else if (char === '"') quoted = false;
            else field += char;
            continue;
        }
        if (char === '"') quoted = true;
        else if (char === ',') {
            row.push(field);
            field = '';
        } else if (char === '\n') {
            row.push(field.replace(/\r$/, ''));
            if (row.some((value) => value !== '')) records.push(row);
            row = [];
            field = '';
        } else field += char;
    }
    if (quoted) throw new Error('CSV contains an unterminated quoted field');
    if (field !== '' || row.length > 0) {
        row.push(field.replace(/\r$/, ''));
        records.push(row);
    }
    return records;
}

export function loadCases(source) {
    const [headers, ...records] = parseCsv(source);
    if (!headers || headers.join('\u0000') !== REQUIRED_HEADERS.join('\u0000')) {
        throw new Error(`CSV headers must be exactly: ${REQUIRED_HEADERS.join(', ')}`);
    }
    const seen = new Set();
    return records.map((record, index) => {
        if (record.length !== REQUIRED_HEADERS.length)
            throw new Error(`CSV row ${index + 2} has ${record.length} columns, expected 10`);
        const entry = Object.fromEntries(headers.map((header, column) => [header, record[column]]));
        if (!entry.用例编号 || seen.has(entry.用例编号))
            throw new Error(`CSV row ${index + 2} has a missing or duplicate case id`);
        if (!VALID_AUTOMATION.has(entry.自动化状态))
            throw new Error(`CSV row ${index + 2} has an invalid automation status`);
        seen.add(entry.用例编号);
        entry.references = entry.对应测试
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((reference) => {
                const marker = reference.indexOf(' :: ');
                if (marker < 1) throw new Error(`Invalid test reference: ${reference}`);
                return { file: reference.slice(0, marker), name: reference.slice(marker + 4) };
            });
        return entry;
    });
}

function normalizeRelative(file) {
    return path.relative(ROOT, path.resolve(file)).split(path.sep).join('/');
}

export function collectVitestStatuses(payload) {
    const statuses = new Map();
    for (const result of payload.testResults ?? []) {
        const file = normalizeRelative(result.name);
        for (const assertion of result.assertionResults ?? []) {
            const fullName = [...(assertion.ancestorTitles ?? []), assertion.title].join(' > ');
            statuses.set(`${file} :: ${fullName}`, assertion.status ?? 'skipped');
        }
    }
    return statuses;
}

function manualOnly(testCase) {
    const environment = `${testCase.前置条件} ${testCase.测试数据}`;
    return /macOS (?:x64|arm64)|Apple Silicon|Intel/u.test(environment);
}

export function evaluateCases(cases, statuses) {
    return cases.map((testCase) => {
        const referenceResults = testCase.references.map((reference) => {
            const key = `${reference.file} :: ${reference.name}`;
            return { ...reference, status: statuses.get(key) ?? 'missing' };
        });
        const failed = referenceResults.some(({ status }) => status === 'failed');
        const blocked = referenceResults.some(({ status }) =>
            ['missing', 'skipped', 'pending', 'todo'].includes(status),
        );
        let result;
        let next;
        if (failed) {
            result = 'failed';
            next = 'developer';
        } else if (testCase.自动化状态 === '已自动化') {
            result = blocked ? 'blocked' : 'passed';
            next = blocked ? 'developer' : 'none';
        } else if (testCase.自动化状态 === '部分自动化') {
            result = blocked ? 'blocked' : 'automated-part-passed';
            next = blocked ? 'developer' : 'agent';
        } else if (testCase.自动化状态 === '待自动化') {
            result = 'not-run';
            next = 'developer';
        } else {
            result = 'not-run';
            next = manualOnly(testCase) ? 'manual' : 'agent';
        }
        return {
            id: testCase.用例编号,
            module: testCase.所属模块,
            title: testCase.用例标题,
            priority: testCase.优先级,
            definitionStatus: testCase.自动化状态,
            result,
            next,
            prerequisites: testCase.前置条件,
            data: testCase.测试数据,
            steps: testCase.操作步骤,
            expected: testCase.预期结果,
            references: referenceResults,
        };
    });
}

function parseArguments(argv) {
    const options = { report: DEFAULT_REPORT, liveApi: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--live-api') options.liveApi = true;
        else if (argument === '--report') {
            const value = argv[index + 1];
            if (!value) throw new Error('--report requires a path');
            options.report = path.resolve(value);
            index += 1;
        } else throw new Error(`Unknown argument: ${argument}`);
    }
    return options;
}

async function runLiveCatalogCheck() {
    const apiKey = process.env.TOKENSAPI_TEST_API_KEY?.trim();
    if (!apiKey) throw new Error('TOKENSAPI_TEST_API_KEY is required with --live-api');
    const baseURL = process.env.TOKENSAPI_TEST_BASE_URL?.trim() || 'https://tokensapi.ai/v1';
    const parsed = new URL(baseURL);
    if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
    )
        throw new Error('TOKENSAPI_TEST_BASE_URL must be a credential-free HTTPS URL');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const startedAt = Date.now();
    try {
        const response = await fetch(
            new URL('models', `${parsed.toString().replace(/\/$/u, '')}/`),
            {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: controller.signal,
            },
        );
        if (!response.ok) throw new Error(`catalog returned HTTP ${response.status}`);
        const body = await response.json();
        const models = Array.isArray(body?.data) ? body.data.filter((model) => model?.id) : [];
        if (models.length === 0) throw new Error('catalog returned no models');
        return {
            status: 'passed',
            target: parsed.host,
            modelCount: models.length,
            elapsedMs: Date.now() - startedAt,
        };
    } finally {
        clearTimeout(timer);
    }
}

function runVitest(files) {
    const executable = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const child = spawnSync(
        process.execPath,
        [executable, 'run', ...files, '--reporter=json', '--maxWorkers=1', '--testTimeout=15000'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (child.error) throw child.error;
    let payload;
    try {
        payload = JSON.parse(child.stdout);
    } catch (error) {
        throw new Error(
            `Vitest did not return JSON: ${error.message}\n${child.stderr.slice(-2000)}`,
        );
    }
    return { payload, exitCode: child.status ?? 1, stderr: child.stderr };
}

function countsBy(items, key) {
    return Object.fromEntries(
        [...new Set(items.map((item) => item[key]))]
            .sort()
            .map((value) => [value, items.filter((item) => item[key] === value).length]),
    );
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    const cases = loadCases(fs.readFileSync(CSV_PATH, 'utf8'));
    const files = [
        ...new Set(cases.flatMap((testCase) => testCase.references.map(({ file }) => file))),
    ];
    const vitest = runVitest(files);
    const results = evaluateCases(cases, collectVitestStatuses(vitest.payload));
    let liveApi = { status: 'not-requested' };
    if (options.liveApi) {
        try {
            liveApi = await runLiveCatalogCheck();
        } catch (error) {
            liveApi = {
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        commit: spawnSync('git', ['rev-parse', 'HEAD'], {
            cwd: ROOT,
            encoding: 'utf8',
        }).stdout.trim(),
        csv: path.relative(ROOT, CSV_PATH).split(path.sep).join('/'),
        vitest: {
            exitCode: vitest.exitCode,
            total: vitest.payload.numTotalTests,
            passed: vitest.payload.numPassedTests,
            failed: vitest.payload.numFailedTests,
            skipped: vitest.payload.numPendingTests,
        },
        liveApi,
        summary: { byResult: countsBy(results, 'result'), byNext: countsBy(results, 'next') },
        cases: results,
    };
    fs.mkdirSync(path.dirname(options.report), { recursive: true });
    fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Functional cases: ${results.length}`);
    console.log(`Results: ${JSON.stringify(report.summary.byResult)}`);
    console.log(`Next: ${JSON.stringify(report.summary.byNext)}`);
    console.log(`Evidence: ${path.relative(ROOT, options.report)}`);
    const failed = results.some(({ result }) => ['failed', 'blocked'].includes(result));
    if (failed || vitest.exitCode !== 0 || liveApi.status === 'failed') process.exitCode = 1;
    return report;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
