/*
 node-jvm
 Copyright (c) 2013 Yaroslav Gaponov <yaroslav.gaponov@gmail.com>
*/

module J2ME {
  declare var ZipFile;
  declare var snarf;
  export var classCounter = new Metrics.Counter(true);
  declare var JARStore;

  export class ClassRegistry {
    /**
     * List of directories to look for source files in.
     */
    sourceDirectories: string [];

    /**
     * All source code, only ever used for debugging.
     */
    sourceFiles: Map<string, string []>;

    unwindMethodInfos:Map<Kind, MethodInfo>;

    /**
     * List of classes whose sources files were not found. We keep track
     * of them so we don't have to search for them over and over.
     */
    missingSourceFiles: Map<string, string []>;

    classes: Map<string, ClassInfo>;

    preInitializedClasses: ClassInfo [];

    java_lang_Object: ClassInfo;
    java_lang_Class: ClassInfo;
    java_lang_String: ClassInfo;
    java_lang_Thread: ClassInfo;

    constructor() {
      this.sourceDirectories = [];
      this.sourceFiles = Object.create(null);
      this.missingSourceFiles = Object.create(null);

      this.classes = Object.create(null);
      this.preInitializedClasses = [];
      this.unwindMethodInfos = Object.create(null);
    }

    initializeBuiltinClasses() {
      // These classes are guaranteed to not have a static initializer.
      enterTimeline("initializeBuiltinClasses");
      this.java_lang_Object = this.loadClass("java/lang/Object");
      this.java_lang_Class = this.loadClass("java/lang/Class");
      this.java_lang_String = this.loadClass("java/lang/String");
      this.java_lang_Thread = this.loadClass("java/lang/Thread");

      this.preInitializedClasses.push(this.java_lang_Object);
      this.preInitializedClasses.push(this.java_lang_Class);
      this.preInitializedClasses.push(this.java_lang_String);
      this.preInitializedClasses.push(this.java_lang_Thread);

      /**
       * Force these frequently used classes to be initialized eagerly. We can
       * skip the class initialization check for them. This is only possible
       * because they don't have any static state.
       */
      var classNames = [
        "java/lang/Integer",
        "java/lang/Character",
        "java/lang/Math",
        "java/util/HashtableEntry",
        "java/lang/StringBuffer",
        "java/util/Vector",
        "java/io/IOException",
        "java/lang/IllegalArgumentException",
        // Preload the Isolate class, that is needed to start the VM (see context.ts)
        "com/sun/cldc/isolate/Isolate",
        "org/mozilla/internal/Sys",
        "java/lang/System",
        "java/lang/RuntimeException",
        "java/lang/IllegalStateException",
        "java/lang/Long",
        "java/lang/NullPointerException",
        "java/lang/Boolean",
        "java/util/Hashtable",
        "java/lang/IndexOutOfBoundsException",
        "java/lang/StringIndexOutOfBoundsException",
        // Preload the Isolate class, that is needed to start the VM (see jvm.ts)
        "com/sun/cldc/isolate/Isolate",
      ];

      for (var i = 0; i < classNames.length; i++) {
        this.preInitializedClasses.push(this.loadClass(classNames[i]));
      }

      var primitiveTypes = "ZCFDBSIJ";
      // Link primitive arrays.
      PrimitiveArrayClassInfo.initialize();
      for (var i = 0; i < primitiveTypes.length; i++) {
        this.getClass("[" + primitiveTypes[i]);
      }
      leaveTimeline("initializeBuiltinClasses");
    }

    isPreInitializedClass(classInfo: ClassInfo) {
      if (classInfo instanceof PrimitiveClassInfo) {
        return true;
      }
      return this.preInitializedClasses.indexOf(classInfo) >= 0;
    }

    addSourceDirectory(name: string) {
      this.sourceDirectories.push(name);
    }

    getSourceLine(sourceLocation: SourceLocation): string {
      if (typeof snarf === "undefined") {
        // Sorry, no snarf in the browser. Do async loading instead.
        return null;
      }
      var source = this.sourceFiles[sourceLocation.className];
      if (!source && !this.missingSourceFiles[sourceLocation.className]) {
        for (var i = 0; i < this.sourceDirectories.length; i++) {
          try {
            var path = this.sourceDirectories[i] + "/" + sourceLocation.className + ".java";
            var file = snarf(path);
            if (file) {
              source = this.sourceFiles[sourceLocation.className] = file.split("\n");
            }
          } catch (x) {
            // Keep looking.
            //stderrWriter.writeLn("" + x);
          }
        }
      }
      if (source) {
        return source[sourceLocation.lineNumber - 1];
      }
      this.missingSourceFiles[sourceLocation.className] = true;
      return null;
    }

    loadClassBytes(bytes: Uint8Array): ClassInfo {
      enterTimeline("loadClassBytes");
      var classInfo = new ClassInfo(bytes);
      leaveTimeline("loadClassBytes");
      loadWriter && loadWriter.writeLn(classInfo.getClassNameSlow() + " -> " + classInfo.superClassName + ";");
      this.classes[classInfo.getClassNameSlow()] = classInfo;
      return classInfo;
    }

    loadClassFile(fileName: string): ClassInfo {
      loadWriter && loadWriter.enter("> Loading Class File: " + fileName);
      var bytes = JARStore.loadFile(fileName);
      if (!bytes) {
        loadWriter && loadWriter.leave("< ClassNotFoundException");
        throw new (ClassNotFoundException)(fileName);
      }
      var self = this;
      var classInfo = this.loadClassBytes(bytes);
      if (classInfo.superClassName) {
        classInfo.superClass = this.loadClass(classInfo.superClassName);
        classInfo.depth = classInfo.superClass.depth + 1;
        var superClass = classInfo.superClass;
        superClass.subClasses.push(classInfo);
        while (superClass) {
          superClass.allSubClasses.push(classInfo);
          superClass = superClass.superClass;
        }
      }
      classInfo.complete();
      loadWriter && loadWriter.leave("<");
      return classInfo;
    }

    loadClass(className: string): ClassInfo {
      var classInfo = this.classes[className];
      if (classInfo) {
        return classInfo;
      }
      return this.loadClassFile(className + ".class");
    }

    getEntryPoint(classInfo: ClassInfo): MethodInfo {
      var methods = classInfo.getMethods();
      for (var i = 0; i < methods.length; i++) {
        var method = methods[i];
        if (method.isPublic && method.isStatic && !method.isNative &&
            method.name === "main" &&
            method.signature === "([Ljava/lang/String;)V") {
          return method;
        }
      }
    }

    getClass(className: string): ClassInfo {
      var classInfo = this.classes[className];
      if (!classInfo) {
        if (className[0] === "[") {
          classInfo = this.createArrayClass(className);
        } else {
          classInfo = this.loadClass(className);
        }
        if (!classInfo)
          return null;
      }
      return classInfo;
    }

    createArrayClass(typeName: string): ArrayClassInfo {
      var elementType = typeName.substr(1);
      var classInfo;
      if (PrimitiveArrayClassInfo[elementType]) {
        classInfo = PrimitiveArrayClassInfo[elementType];
      } else {
        if (elementType[0] === "L") {
          elementType = elementType.substr(1).replace(";", "");
        }
        classInfo = new ObjectArrayClassInfo(this.getClass(elementType));
      }
      return this.classes[typeName] = classInfo;
    }

    getUnwindMethodInfo(returnKind: Kind, opCode?: Bytecode.Bytecodes):MethodInfo {
      var key = "" + returnKind + opCode;

      if (this.unwindMethodInfos[key]) {
        return this.unwindMethodInfos[key];
      }
      var classInfo = CLASSES.getClass("org/mozilla/internal/Sys");
      var methodInfo;
      var unwindMethodName = "unwind" + (opCode ? "FromInvoke" : "");
      switch (returnKind) {
        case Kind.Long:
          methodInfo = classInfo.getMethodByNameString(unwindMethodName, "(J)J");
          break;
        case Kind.Double:
          methodInfo = classInfo.getMethodByNameString(unwindMethodName, "(D)D");
          break;
        case Kind.Float:
          methodInfo = classInfo.getMethodByNameString(unwindMethodName, "(F)F");
          break;
        case Kind.Int:
        case Kind.Byte:
        case Kind.Char:
        case Kind.Short:
        case Kind.Boolean:
          methodInfo = classInfo.getMethodByNameString(unwindMethodName, "(I)I");
          break;
        case Kind.Reference:
          methodInfo = classInfo.getMethodByNameString(unwindMethodName, "(Ljava/lang/Object;)Ljava/lang/Object;");
          break;
        case Kind.Void:
          methodInfo = classInfo.getMethodByNameString(unwindMethodName, "()V");
          break;
        default:
          release || Debug.assert(false, "Invalid Kind: " + getKindName(returnKind));
      }
      release || Debug.assert(methodInfo, "Must find unwind method");
      this.unwindMethodInfos[key] = methodInfo;
      return methodInfo;
    }
  }

  export var ClassNotFoundException = function(message) {
    this.message = message;
  };

  ClassNotFoundException.prototype = Object.create(Error.prototype);
  ClassNotFoundException.prototype.name = "ClassNotFoundException";
  ClassNotFoundException.prototype.constructor = ClassNotFoundException;
}

