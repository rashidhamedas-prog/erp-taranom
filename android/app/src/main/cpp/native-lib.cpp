// JNI bridge to the nodejs-mobile runtime (libnode.so from the
// nodejs-mobile-android AAR). Mirrors the official android-native sample:
// receives an argv array from Java and hands it to node::Start on this
// (background) thread.
#include <jni.h>
#include <string>
#include <cstdlib>

#include "node.h"

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

    int result = node::Start(argc, argv);

    free(argv);
    free(args_buffer);

    jclass integerClass = env->FindClass("java/lang/Integer");
    jmethodID ctor = env->GetMethodID(integerClass, "<init>", "(I)V");
    return env->NewObject(integerClass, ctor, result);
}
