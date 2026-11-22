import * as React from 'react';
import { Text, View, StyleSheet, Platform, type TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { darkTheme } from '@/theme';
import { SyntaxText } from './SyntaxText';
import type { TerminalToolOutput } from '@/sync/typesRaw';
import { t } from '@/text';

interface CommandViewProps {
    command: string;
    prompt?: string;
    stdout?: string | null;
    stderr?: string | null;
    error?: string | null;
    terminal?: TerminalToolOutput;
    terminalOutputLabel?: string;
    wrapText?: boolean;
    // Legacy prop for backward compatibility
    output?: string | null;
    maxHeight?: number;
    fullWidth?: boolean;
    hideEmptyOutput?: boolean;
    /** Detail-only: compact chat rows never enqueue tokenization. */
    syntaxHighlighting?: boolean;
    /** null for activity labels (waiting, stopping), which are not shell code. */
    commandLanguage?: 'bash' | 'powershell' | null;
}

export const CommandView = React.memo<CommandViewProps>(({
    command,
    prompt = '$',
    stdout,
    stderr,
    error,
    terminal,
    terminalOutputLabel,
    wrapText,
    output,
    maxHeight,
    fullWidth,
    hideEmptyOutput,
    syntaxHighlighting = false,
    commandLanguage = 'bash',
}) => {
    const { theme } = useUnistyles();
    // Use legacy output if new props aren't provided
    const hasNewProps = stdout !== undefined || stderr !== undefined || error !== undefined || terminal !== undefined;
    const outputStdout = terminal ? terminal.stdout : stdout;
    const outputStderr = terminal ? terminal.stderr : stderr;
    const combinedOutput = terminal && outputStdout === undefined && outputStderr === undefined ? terminal.output : undefined;

    const styles = React.useMemo(() => StyleSheet.create({
        container: {
            backgroundColor: theme.colors.terminal.background,
            borderRadius: 8,
            overflow: 'hidden',
            padding: 16,
            alignItems: 'flex-start',
            justifyContent: 'flex-start',
        },
        line: {
            alignItems: 'baseline',
            flexDirection: 'row',
            flexWrap: 'wrap',
        },
        wrappedLine: {
            width: '100%',
            flexWrap: 'nowrap',
        },
        wrappedText: {
            minWidth: 0,
            maxWidth: '100%',
        },
        promptText: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 14,
            lineHeight: 20,
            color: theme.colors.terminal.prompt,
            fontWeight: '600',
        },
        commandText: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 14,
            color: theme.colors.terminal.command,
            lineHeight: 20,
            flex: 1,
        },
        stdout: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.stdout,
            lineHeight: 18,
            marginTop: 8,
        },
        stderr: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.stderr,
            lineHeight: 18,
            marginTop: 8,
        },
        error: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.error,
            lineHeight: 18,
            marginTop: 8,
        },
        emptyOutput: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.emptyOutput,
            lineHeight: 18,
            marginTop: 8,
            fontStyle: 'italic',
        },
        outputLabel: {
            fontSize: 12,
            fontWeight: '600',
            color: theme.colors.terminal.emptyOutput,
            marginTop: 10,
        },
    }), [theme]);

    // The terminal surface stays dark in both themes. Plain runs inherit the
    // command/stdout/stderr color; classified tokens use the dark diff palette.
    const terminalText = (code: string, style: TextStyle, language: string | null) => {
        const textStyle = wrapText ? [style, styles.wrappedText] : style;
        return syntaxHighlighting && language ? (
            <SyntaxText code={code} language={language} style={textStyle} colors={darkTheme.colors.diff.syntax} />
        ) : <Text style={textStyle} selectable={syntaxHighlighting}>{code}</Text>;
    };

    return (
        <View style={[
            styles.container, 
            maxHeight ? { maxHeight } : undefined,
            fullWidth ? { width: '100%' } : undefined
        ]}>
            {/* Command Line */}
            <View style={[styles.line, wrapText && styles.wrappedLine]}>
                {prompt ? <Text style={styles.promptText}>{prompt} </Text> : null}
                {terminalText(command, styles.commandText, commandLanguage)}
            </View>

            {hasNewProps ? (
                <>
                    {combinedOutput ? (
                        <>
                            <Text style={styles.outputLabel}>{terminalOutputLabel}</Text>
                            {terminalText(combinedOutput, styles.stdout, 'shell-session')}
                        </>
                    ) : null}
                    {/* Standard Output */}
                    {outputStdout && (terminal || outputStdout.trim()) ? (
                        <>
                            {terminal ? <Text style={styles.outputLabel}>stdout</Text> : null}
                            {terminalText(outputStdout, styles.stdout, 'shell-session')}
                        </>
                    ) : null}

                    {/* Standard Error */}
                    {outputStderr && (terminal || outputStderr.trim()) ? (
                        <>
                            {terminal ? <Text style={styles.outputLabel}>stderr</Text> : null}
                            {terminalText(outputStderr, styles.stderr, 'shell-session')}
                        </>
                    ) : null}

                    {/* Error Message */}
                    {error && (
                        <Text style={styles.error}>{error}</Text>
                    )}

                    {/* Empty output indicator */}
                    {!combinedOutput && !outputStdout && !outputStderr && !error && !hideEmptyOutput && (
                        <Text style={styles.emptyOutput}>[Command completed with no output]</Text>
                    )}
                    {terminal?.exitCode !== undefined ? <Text style={styles.outputLabel}>{t('tools.fullView.exitCode', { code: terminal.exitCode })}</Text> : null}
                </>
            ) : (
                /* Legacy output format */
                output && (
                    terminalText('\n---\n' + output, styles.commandText, 'shell-session')
                )
            )}
        </View>
    );
});

