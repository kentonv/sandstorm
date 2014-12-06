# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
# All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# You may override the following vars on the command line to suit
# your config.
CXX=clang++
CXXFLAGS=-O2 -Wall
BUILD=0
XZ_FLAGS=

# LANG specifies the locale used in run-bundle.
ifneq ($(shell echo $(LANG) | grep "\.UTF-8$$" -), $(LANG))
$(error LANG must end with ".UTF-8")
endif

# You generally should not modify these.
CXXFLAGS2=-std=c++1y -Isrc -Itmp $(CXXFLAGS) -DSANDSTORM_BUILD=$(BUILD)
NODE_INCLUDE=$(HOME)/.meteor/tools/latest/include/node/

# TODO(cleanup): Originally each command here was defined in one file and there
#   was really no shared code. That seems to have changed. Perhaps it's time
#   to separate compilation and linking.

.PHONY: all install clean shell-env

all: sandstorm-$(BUILD).tar.xz

clean:
	rm -rf bin tmp node_modules bundle shell-bundle sandstorm-*.tar.xz shell/public/edit.png shell/public/restart.png shell/public/trash.png shell/public/wrench.png shell/public/download.png shell/public/key.png shell/public/close.png shell/public/menu.png shell/public/*-m.png .shell-env shell/packages/*/.build* shell/packages/*/.npm/package/node_modules

install: sandstorm-$(BUILD).tar.xz install.sh
	@./install.sh sandstorm-$(BUILD).tar.xz

shell-env: .shell-env

.shell-env: node_modules/sandstorm/grain.capnp shell/public/edit.png shell/public/restart.png shell/public/trash.png shell/public/wrench.png shell/public/download.png shell/public/key.png shell/public/close.png shell/public/menu.png shell/public/edit-m.png shell/public/restart-m.png shell/public/trash-m.png shell/public/wrench-m.png shell/public/download-m.png shell/public/key-m.png shell/public/close-m.png
	@touch .shell-env

update: sandstorm-$(BUILD).tar.xz
	sudo sandstorm update $(PWD)/sandstorm-$(BUILD).tar.xz

bin/spk: tmp/genfiles src/sandstorm/spk.c++ src/sandstorm/fuse.c++ src/sandstorm/union-fs.c++ src/sandstorm/send-fd.c++
	@echo "building bin/spk..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/spk.c++ src/sandstorm/fuse.c++ src/sandstorm/union-fs.c++ src/sandstorm/send-fd.c++ tmp/sandstorm/*.capnp.c++ -o bin/spk -static $(CXXFLAGS2) -lcapnpc `pkg-config libsodium capnp-rpc --cflags --libs`

bin/sandstorm-http-bridge: tmp/genfiles src/sandstorm/sandstorm-http-bridge.c++
	@echo "building bin/sandstorm-http-bridge..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/sandstorm-http-bridge.c++ src/joyent-http/http_parser.c++ tmp/sandstorm/*.capnp.c++ -o bin/sandstorm-http-bridge -static $(CXXFLAGS2) `pkg-config capnp-rpc --cflags --libs`

bin/sandstorm-supervisor: tmp/genfiles src/sandstorm/supervisor-main.c++ src/sandstorm/send-fd.c++
	@echo "building bin/sandstorm-supervisor..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/supervisor-main.c++ src/sandstorm/send-fd.c++ tmp/sandstorm/*.capnp.c++ -o bin/sandstorm-supervisor $(CXXFLAGS2) `pkg-config capnp-rpc --cflags --libs` `pkg-config libseccomp --cflags --libs`

bin/minibox: src/sandstorm/minibox.c++
	@echo "building bin/minibox..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/minibox.c++ -o bin/minibox $(CXXFLAGS2) `pkg-config capnp --cflags --libs`

node_modules/sandstorm/grain.capnp: src/sandstorm/*.capnp
	@echo "copying sandstorm protocols to node_modules/sandstorm..."
	@mkdir -p node_modules/sandstorm
	@cp src/sandstorm/*.capnp node_modules/sandstorm

tmp/genfiles: src/sandstorm/*.capnp
	@echo "generating capnp files..."
	@mkdir -p tmp
	@capnp compile --src-prefix=src -oc++:tmp  src/sandstorm/*.capnp
	@touch tmp/genfiles

bin/run-bundle: src/sandstorm/run-bundle.c++ src/sandstorm/send-fd.c++ tmp/genfiles
	@echo "building bin/run-bundle..."
	@mkdir -p bin
	@$(CXX) src/sandstorm/run-bundle.c++ src/sandstorm/send-fd.c++ tmp/sandstorm/*.capnp.c++ -o bin/run-bundle -static $(CXXFLAGS2) -DENV_LANG=$(LANG) `pkg-config capnp-rpc --cflags --libs`

shell/public/%.png: icons/%.svg
	convert -scale 24x24 -negate -evaluate multiply 0.87 $< $@
shell/public/%-m.png: icons/%.svg
	convert -scale 32x32 $< $@

shell-bundle: shell/client/* shell/server/* shell/shared/* shell/public/* shell/.meteor/packages shell/.meteor/release shell/.meteor/versions .shell-env
	@echo "bundling meteor frontend..."
	@cd shell && PYTHONPATH=$HOME/.meteor/tools/latest/lib/node_modules/npm/node_modules/node-gyp/gyp/pylib meteor bundle --directory ../shell-bundle

bundle: bin/spk bin/minibox bin/sandstorm-supervisor bin/sandstorm-http-bridge bin/run-bundle shell-bundle make-bundle.sh
	./make-bundle.sh

sandstorm-$(BUILD).tar.xz: bundle
	tar c --transform="s,^bundle,sandstorm-$(BUILD)," bundle | xz -c $(XZ_FLAGS) > sandstorm-$(BUILD).tar.xz

.docker: sandstorm-$(BUILD).tar.xz Dockerfile
	docker build -t sandstorm .
	@touch .docker
