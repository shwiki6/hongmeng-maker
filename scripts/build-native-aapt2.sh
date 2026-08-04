#!/usr/bin/env bash
set -euxo pipefail

git clone --depth 1 "${AAPT2_REPO}" aapt2-src
cd aapt2-src

sed -i '1c#!/usr/bin/env bash' build.sh
sed -i 's/find_package(Threads REQUIRED)/if(NOT TARGET Threads::Threads)\n  add_library(Threads::Threads INTERFACE IMPORTED)\nendif()\nset_target_properties(Threads::Threads PROPERTIES INTERFACE_LINK_LIBRARIES "-pthread")/' cmake/Dependencies.cmake
sed -i '/CMAKE_C_COMPILER_TARGET/d; /CMAKE_CXX_COMPILER_TARGET/d; /-femulated-tls/d' cmake/CompilerFlags.cmake

# Ubuntu's android-liblog-dev package may ship only a versioned liblog file,
# while this standalone CMake project links the conventional -llog name.
log_lib=$(find /usr/lib /lib -name 'liblog.so*' -type f -o -name 'liblog.so*' -type l | head -n1)
test -n "$log_lib"
sudo ln -sf "$log_lib" /usr/lib/aarch64-linux-gnu/liblog.so

mkdir -p /tmp/android-headers third_party/androidfw/include
curl -fL --retry 5 --retry-all-errors \
  -o /tmp/android-headers/native.deb \
  https://mirrors.aliyun.com/ubuntu/pool/universe/a/android-platform-tools/android-platform-frameworks-native-headers_34.0.5-12_all.deb
echo '1636567f75417966cc2b9a3b3bacc962b5240fbc95ec9a914d3f65558651d307  /tmp/android-headers/native.deb' | sha256sum -c -
dpkg-deb -x /tmp/android-headers/native.deb /tmp/android-headers/native
cp -a /tmp/android-headers/native/usr/include/android/android third_party/androidfw/include/

sed -i '/ACONFIGURATION_COLOR_MODE = 0x10000,/a\    ACONFIGURATION_GRAMMATICAL_GENDER = 0x20000,\n    ACONFIGURATION_GRAMMATICAL_GENDER_ANY = 0,\n    ACONFIGURATION_GRAMMATICAL_GENDER_NEUTER = 1,\n    ACONFIGURATION_GRAMMATICAL_GENDER_FEMININE = 2,\n    ACONFIGURATION_GRAMMATICAL_GENDER_MASCULINE = 3,' third_party/androidfw/include/android/configuration.h
sed -i '/#include "androidfw\/ApkParsing.h"/a#include <cstring>' third_party/androidfw/ApkParsing.cpp
sed -i '/#include <functional>/a#include <memory>' third_party/aapt2/cmd/Command.h
sed -i '/#include <optional>/i#include <cstdint>' third_party/aapt2/AppInfo.h
sed -i '/extern "C" int posix_strerror_r/i#ifndef __BIONIC__\nextern "C" int __xpg_strerror_r(int, char*, size_t);\n#endif' third_party/libbase/posix_strerror_r.cpp
sed -i 's/return strerror_r(errnum, buf, buflen);/return __xpg_strerror_r(errnum, buf, buflen);/' third_party/libbase/posix_strerror_r.cpp
sed -i -e 's/^constexpr inline uint32_t packLocale/inline uint32_t packLocale/' \
  -e 's/^constexpr inline uint32_t packScript/inline uint32_t packScript/' \
  third_party/androidfw/include/androidfw/LocaleDataLookup.h
sed -i '/const const_iterator operator++(int)/i\
        const_iterator& operator--() { safe_ptr_ = safe_ptr_ + (-1); return *this; }\
        const_iterator operator--(int) { const_iterator temp(*this); safe_ptr_ = safe_ptr_ + (-1); return temp; }\
' third_party/incfs/util/include/util/map_ptr.h

CC=clang CXX='clang++ -stdlib=libstdc++ -include cstring' ./build.sh
file build/aapt2
./build/aapt2 version
install -Dm755 build/aapt2 "${GITHUB_WORKSPACE}/package/aapt2"
