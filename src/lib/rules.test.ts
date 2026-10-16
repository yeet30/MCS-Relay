import { expect, test } from 'vitest';
import { addRule, cleanRuleInput, hasRule, sameRules } from './rules';

test('cleanRuleInput normalizes what people type', () => {
    expect(cleanRuleInput('  logs\\  ')).toBe('logs/');
    expect(cleanRuleInput('./world//data/raids.dat')).toBe('world/data/raids.dat');
    expect(cleanRuleInput('/crash-reports/')).toBe('crash-reports/');
    expect(cleanRuleInput('*.tmp')).toBe('*.tmp');
});

test('cleanRuleInput rejects empty rules and paths outside the server folder', () => {
    expect(cleanRuleInput('   ')).toBeNull();
    expect(cleanRuleInput('/')).toBeNull();
    expect(cleanRuleInput('../secrets.txt')).toBeNull();
    expect(cleanRuleInput('world/../../x')).toBeNull();
});

test('rules compare case-insensitively', () => {
    expect(hasRule(['logs/'], 'Logs/')).toBe(true);
    expect(addRule(['logs/'], 'LOGS/')).toEqual(['logs/']);
    expect(addRule(['logs/'], '*.tmp')).toEqual(['logs/', '*.tmp']);
});

test('sameRules', () => {
    expect(sameRules(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameRules(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameRules(['a'], ['a', 'b'])).toBe(false);
});
