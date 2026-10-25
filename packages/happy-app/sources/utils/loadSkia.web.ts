import { LoadSkia } from "@shopify/react-native-skia/lib/module/web";

export async function loadSkia() {
    const basePath = process.env.EXPO_BASE_URL || '';
    await LoadSkia({ locateFile: (file) => `${basePath}/${file}` });
}
