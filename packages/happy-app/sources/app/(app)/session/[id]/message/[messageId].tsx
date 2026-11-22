import * as React from 'react';
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { Text, View, ActivityIndicator } from "react-native";
import { useMessage, useSession, useSessionMessages } from "@/sync/storage";
import { sync } from '@/sync/sync';
import { Deferred } from "@/components/Deferred";
import { ToolFullView } from '@/components/tools/ToolFullView';
import { ToolHeader } from '@/components/tools/ToolHeader';
import { Message } from '@/sync/typesMessage';
import type { Metadata } from '@/sync/storageTypes';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

const stylesheet = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    fullViewContainer: {
        flex: 1,
        padding: 16,
    },
    messageText: {
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
        ...Typography.default(),
    },
}));

export default React.memo(() => {
    const { id: sessionId, messageId, file } = useLocalSearchParams<{ id: string; messageId: string; file?: string }>();
    const router = useRouter();
    const session = useSession(sessionId!);
    const { isLoaded: messagesLoaded } = useSessionMessages(sessionId!);
    const message = useMessage(sessionId!, messageId!);
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const tool = message?.kind === 'tool-call' ? message.tool : undefined;
    const headerTitle = React.useCallback(
        () => <ToolHeader tool={tool} metadata={session?.metadata} />,
        [tool, session?.metadata],
    );
    
    // Trigger session visibility when component mounts, and again after a
    // direct reload hydrates the session list. Message fetches intentionally
    // ignore ids that are not in that list yet.
    const hasSession = !!session;
    React.useEffect(() => {
        if (sessionId) {
            sync.onSessionVisible(sessionId);
        }
    }, [sessionId, hasSession]);
    
    const [missingMessage, setMissingMessage] = React.useState(false);

    // A direct deep link may not be in the latest page. Load older pages until
    // this exact message is found; only preserve the old back navigation when
    // the complete history confirms that it no longer exists.
    React.useEffect(() => {
        setMissingMessage(false);
        if (!messagesLoaded || message || !sessionId || !messageId) return;
        let active = true;
        let retry: ReturnType<typeof setTimeout> | undefined;
        const resolve = async () => {
            while (active) {
                try {
                    const found = await sync.ensureSessionMessage(sessionId, messageId);
                    if (active && !found) setMissingMessage(true);
                    return;
                } catch {
                    await new Promise<void>(done => { retry = setTimeout(done, 1000); });
                }
            }
        };
        void resolve();
        return () => {
            active = false;
            if (retry) clearTimeout(retry);
        };
    }, [messagesLoaded, message, messageId, sessionId]);

    React.useEffect(() => {
        if (missingMessage) router.back();
    }, [missingMessage, router]);
    
    return (
        <>
            <Stack.Screen options={{ headerTitle, headerRight: undefined }} />
            {!session || !messagesLoaded || !message ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : (
                <Deferred>
                    <FullView message={message} metadata={session.metadata} focusFile={file ? decodeURIComponent(file) : undefined} />
                </Deferred>
            )}
        </>
    );
});

function FullView(props: { message: Message; metadata: Metadata | null; focusFile?: string }) {
    const styles = stylesheet;
    
    if (props.message.kind === 'tool-call') {
        return <ToolFullView tool={props.message.tool} metadata={props.metadata} messages={props.message.children} focusFile={props.focusFile} />
    }
    if (props.message.kind === 'agent-text') {
        return (
            <View style={styles.fullViewContainer}>
                <Text style={styles.messageText}>{props.message.text}</Text>
            </View>
        )
    }
    if (props.message.kind === 'user-text') {
        return (
            <View style={styles.fullViewContainer}>
                <Text style={styles.messageText}>{props.message.text}</Text>
            </View>
        )
    }
    return null;
}
