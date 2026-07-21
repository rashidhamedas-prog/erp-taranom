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
// are invisible to later process.dlopen("better_sqlite3.node"). Promote libnode
// to RTLD_GLOBAL before any native addon load (JaneaSystems/nodejs-mobile#70).
static void promoteLibnodeGlobal() {
    dlerror();
    void *h = dlopen("libnode.so", RTLD_NOLOAD | RTLD_GLOBAL);
    if (!h) {
        h = dlopen("libnode.so", RTLD_NOW | RTLD_GLOBAL);
    }
    if (!h) {
        ALOGE("promoteLibnodeGlobal failed: %s", dlerror());
    } else {
        ALOGI("promoteLibnodeGlobal ok handle=%p", h);
    }
}

extern "C" JNIEXPORT void JNICALL
Java_ir_taranom_crm_MainActivity_promoteNodeSymbols(
        JNIEnv * /* env */, jobject /* this */) {
    promoteLibnodeGlobal();
}

extern "C" JNIEXPORT jobject JNICALL
Java_ir_taranom_crm_MainActivity_startNodeWithArguments(
        JNIEnv *env, jobject /* this */, jobjectArray arguments) {

    promoteLibnodeGlobal();

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

    int result = node::Start(argc, argv);

    free(argv);
    free(args_buffer);

    jclass integerClass = env->FindClass("java/lang/Integer");
    jmethodID ctor = env->GetMethodID(integerClass, "<init>", "(I)V");
    return env->NewObject(integerClass, ctor, result);
}
