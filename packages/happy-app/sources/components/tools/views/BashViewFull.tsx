import * as React from 'react';
import { View, StyleSheet } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { CommandView } from '@/components/CommandView';
import { getTerminalToolCommand, getToolActivityLabel } from '@/utils/toolDisplay';
import { getShellControl } from '@/utils/happyToolDisplay';
import { getTerminalToolResult } from '@/utils/toolResult';
import { CodeView } from '@/components/CodeView';
import { ToolSectionView } from '../ToolSectionView';
import { t } from '@/text';

interface BashViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const BashViewFull = React.memo<BashViewFullProps>(({ tool, metadata }) => {
    const codeBuddy = metadata?.flavor === 'codebuddy' || tool.terminal !== undefined;
    const rawCommand = codeBuddy && typeof tool.input?.command === 'string' && tool.input.command.trim()
        ? tool.input.command as string : null;
    const command = rawCommand ?? getTerminalToolCommand(tool);
    const control = getShellControl(tool);
    const result = getTerminalToolResult(tool);
    const parameters = codeBuddy && tool.input && typeof tool.input === 'object'
        ? Object.entries(tool.input).filter(([key]) => key !== 'command' || rawCommand === null) : [];

    return (
        <View style={styles.container}>
            <CommandView
                command={command ?? getToolActivityLabel(tool)}
                prompt={command ? '$' : ''}
                {...result}
                terminal={tool.terminal}
                terminalOutputLabel={tool.terminal?.output ? t('tools.fullView.output') : undefined}
                wrapText={codeBuddy}
                error={tool.terminal?.error ?? (tool.state === 'error' ? result.error || t('tools.fullView.error') : null)}
                hideEmptyOutput={tool.state === 'running'}
                syntaxHighlighting
                commandLanguage={command ? 'bash' : null}
                fullWidth
            />
            {parameters.length > 0 && (
                <ToolSectionView title={t('tools.fullView.inputParams')}>
                    <CodeView code={JSON.stringify(Object.fromEntries(parameters), null, 2)} />
                </ToolSectionView>
            )}
            {control?.chars !== undefined && (
                <ToolSectionView title={t('toolView.input')}>
                    <CodeView code={control.chars} />
                </ToolSectionView>
            )}
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        width: '100%',
        gap: 16,
    },
});
