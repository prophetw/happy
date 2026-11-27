import * as React from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';

type Timing = { admittedAt?: number; resourceAt?: number; startedAt?: number; endedAt?: number; deliveredAt?: number };

const duration = (start: number | undefined, end: number | undefined) =>
    start === undefined || end === undefined || end < start ? '未知' : ((end - start) / 1000).toFixed(2) + ' 秒';

export function DotTaskTiming({ timing, waitingSince, style }: { timing?: Timing; waitingSince?: number; style: StyleProp<TextStyle> }) {
    const t = timing;
    return <>
        {waitingSince !== undefined && <Text style={style}>已等待 {duration(waitingSince, Date.now())}</Text>}
        {t && <Text style={style}>
            排队 {duration(t.admittedAt, t.resourceAt)} · 启动 {duration(t.resourceAt, t.startedAt)} · 执行 {duration(t.startedAt, t.endedAt)}
            {'\n'}回传至 Dot {duration(t.endedAt, t.deliveredAt)} · 接单至送达 {duration(t.admittedAt, t.deliveredAt)}
            {'\n'}回传与总耗时按两端时钟估算。送达以原 Dot 接受结果为准。
        </Text>}
    </>;
}
