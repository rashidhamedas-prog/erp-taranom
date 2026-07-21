// JNI bridge to the nodejs-mobile runtime (libnode.so from the
// nodejs-mobile-android AAR). Mirrors the official android-native sample:
// receives an argv array from Java and hands it to node::Start on this
// (background) thread.
#include <jni.h>
#include <string>
#include <cstring>
#include <cstdlib>
#include <dlfcn.h>
#include <android/log.h>

#include "node.h"

#define LOG_TAG "CRMTaranom"
#define ALOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define ALOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

// Android loads JNI deps with RTLD_LOCAL, so V8/Node symbols inside libnode.so
// are invisible to later process.dlopen("better_sqlite3.node") unless the
// addon has DT_NEEDED=libnode.so AND is opened from the app nativeLibraryDir.
static void promoteLibnodeGlobal(const char *nativeLibDir) {
    dlerror();
    void *h = nullptr;
    if (nativeLibDir && nativeLibDir[0]) {
        std::string full = std::string(nativeLibDir) + "/libnode.so";
        h = dlopen(full.c_str(), RTLD_NOW | RTLD_GLOBAL);
        if (!h) {
            ALOGE("dlopen(%s) failed: %s", full.c_str(), dlerror());
        } else {
            ALOGI("dlopen full libnode ok handle=%p", h);
        }
    }
    if (!h) {
        h = dlopen("libnode.so", RTLD_NOLOAD | RTLD_GLOBAL);
        if (!h) h = dlopen("libnode.so", RTLD_NOW | RTLD_GLOBAL);
        if (!h) ALOGE("promoteLibnodeGlobal failed: %s", dlerror());
        else ALOGI("promoteLibnodeGlobal ok handle=%p", h);
    }
}

static void preloadBetterSqlite3(const char *nativeLibDir) {
    if (!nativeLibDir || !nativeLibDir[0]) return;
    dlerror();
    std::string full = std::string(nativeLibDir) + "/libbetter_sqlite3.so";
    void *h = dlopen(full.c_str(), RTLD_NOW | RTLD_GLOBAL);
    if (!h) {
        ALOGE("preload better_sqlite3 failed: %s", dlerror());
    } else {
        ALOGI("preload better_sqlite3 ok handle=%p path=%s", h, full.c_str());
    }
}

extern "C" JNIEXPORT void JNICALL
Java_ir_taranom_crm_MainActivity_promoteNodeSymbols(
        JNIEnv * /* env */, jobject /* this */) {
    promoteLibnodeGlobal(nullptr);
}

extern "C" JNIEXPORT void JNICALL
Java_ir_taranom_crm_MainActivity_preloadSqliteNative(
        JNIEnv *env, jobject /* this */, jstring nativeLibDirJs) {
    const char *dir = env->GetStringUTFChars(nativeLibDirJs, nullptr);
    promoteLibnodeGlobal(dir);
    preloadBetterSqlite3(dir);
    env->ReleaseStringUTFChars(nativeLibDirJs, dir);
}

extern "C" JNIEXPORT jobject JNICALL
Java_ir_taranom_crm_MainActivity_startNodeWithArguments(
        JNIEnv *env, jobject /* this */, jobjectArray arguments) {

    jsize argc = env->GetArrayLength(arguments);

    // node::Start expects a contiguous argv block
    int total = 0;
    for (jsize i = 0; i < argc; i++) {
        auto s = (jstring) env->GetObjectArrayElement(arguments, i);
        total += env->GetStringUTFLength(s) + 1;
        env->DeleteLocalRef(s);
    }

    char *args_buffer = (char *) calloc(total, sizeof(char));
    char **argv = (char **) calloc(argc, sizeof(char *));
    char *cursor = args_buffer;

    for (jsize i = 0; i < argc; i++) {
        auto js = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *cs = env->GetStringUTFChars(js, nullptr);
        size_t len = strlen(cs);
        memcpy(cursor, cs, len);
        argv[i] = cursor;
        cursor += len + 1;
        env->ReleaseStringUTFChars(js, cs);
        env->DeleteLocalRef(js);
    }

    // argv: [0]=node [1]=main.js [2]=dataDir [3]=port [4]=nativeLibDir
    const char *nativeLibDir = (argc >= 5) ? argv[4] : nullptr;
    promoteLibnodeGlobal(nativeLibDir);
    preloadBetterSqlite3(nativeLibDir);

    int result = node::Start(argc, argv);

    free(argv);
    free(args_buffer);

    jclass integerClass = env->FindClass("java/lang/Integer");
    jmethodID ctor = env->GetMethodID(integerClass, "<init>", "(I)V");
    return env->NewObject(integerClass, ctor, result);
}
