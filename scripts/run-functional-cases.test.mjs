import { describe, expect, it } from 'vitest';
import {
    collectVitestStatuses,
    evaluateCases,
    loadCases,
    parseCsv,
} from './run-functional-cases.mjs';

const headers =
    '用例编号,所属模块,用例标题,前置条件,测试数据,操作步骤,预期结果,优先级,自动化状态,对应测试';

describe('functional case runner', () => {
    it('parses BOM, escaped quotes, commas and multiline cells', () => {
        const rows = parseCsv(`\uFEFFa,b,c\n1,"two,2","line 1\nline ""2"""\n`);
        expect(rows).toEqual([
            ['a', 'b', 'c'],
            ['1', 'two,2', 'line 1\nline "2"'],
        ]);
    });

    it('validates the fixed schema and preserves complete references', () => {
        const cases = loadCases(
            `${headers}\nCASE-001,模块,标题,前置,数据,步骤,预期,P0,已自动化,"src/a.test.ts :: suite > test\n"\n`,
        );
        expect(cases[0].references).toEqual([{ file: 'src/a.test.ts', name: 'suite > test' }]);
    });

    it('maps Vitest assertions back to CSV references', () => {
        const statuses = collectVitestStatuses({
            testResults: [
                {
                    name: new URL('../src/example.test.ts', import.meta.url).pathname,
                    assertionResults: [
                        { ancestorTitles: ['suite'], title: 'test', status: 'passed' },
                    ],
                },
            ],
        });
        expect([...statuses.values()]).toEqual(['passed']);
        expect([...statuses.keys()][0]).toContain('src/example.test.ts :: suite > test');
    });

    it('sends partial and desktop-only cases to an agent, macOS cases to manual', () => {
        const common = {
            所属模块: '模块',
            优先级: 'P0',
            测试数据: '',
            操作步骤: '1. 执行',
            预期结果: '成功',
            references: [],
        };
        const results = evaluateCases(
            [
                {
                    ...common,
                    用例编号: 'A',
                    用例标题: 'partial',
                    前置条件: '',
                    自动化状态: '部分自动化',
                    references: [{ file: 'x.test.ts', name: 'suite > test' }],
                },
                {
                    ...common,
                    用例编号: 'B',
                    用例标题: 'desktop',
                    前置条件: 'Windows Desktop',
                    自动化状态: '人工验收',
                },
                {
                    ...common,
                    用例编号: 'C',
                    用例标题: 'mac',
                    前置条件: 'macOS arm64',
                    自动化状态: '人工验收',
                },
            ],
            new Map([['x.test.ts :: suite > test', 'passed']]),
        );
        expect(results.map(({ result, next }) => [result, next])).toEqual([
            ['automated-part-passed', 'agent'],
            ['not-run', 'agent'],
            ['not-run', 'manual'],
        ]);
    });
});
