ARG SDK_IMAGE=incpption-plan-sdk:alpine3.18
FROM ${SDK_IMAGE}

# The pinned release recipes use generated configure scripts and build
# their normal targets, so they do not call these maintainer/test tools.
RUN apk del --no-network autoconf automake gettext-dev libtool m4 perl && \
    rm -f /usr/bin/ctest /usr/bin/cpack \
        /usr/libexec/gcc/*/*/lto1 /usr/libexec/gcc/*/*/lto-wrapper
