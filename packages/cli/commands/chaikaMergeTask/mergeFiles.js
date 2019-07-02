//app.json中路由需要注入到app.js, 并且根据order字段决定注入顺序
//app.json中alias需要校验冲突，并且注入到package.json中
//package.json中需要校验运行依赖，开发依赖的冲突
//*Config.json需要校验冲突，并合并
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const cwd = process.cwd();
const merge = require('lodash.mergewith');
const shelljs = require('shelljs');
//const semver = require('semver');
const mergeDir = path.join(cwd, '.CACHE/nanachi');
let mergeFilesQueue = require('./mergeFilesQueue');
let diff = require('deep-diff').diff;

/**
 * 
 * @param {String} appJsSrcPath app.js绝对路径
 * @param {Array} pages 所有的页面路径
 * @return {Object} 
 */
function getMergedAppJsConent( appJsSrcPath, pages = [] ) {
    let allRoutesStr = pages.map(function(pageRoute){
        if ( !/^\.\//.test(pageRoute) ) {
            pageRoute = './' + pageRoute;
        }
        pageRoute = `import '${pageRoute}';\n`;
        return pageRoute;
    }).join('');

    return new Promise(function(rel, rej) {
        let appJsSrcContent = '';
        let appJsDist =  path.join(mergeDir, 'source', 'app.js');
        try {
            appJsSrcContent = fs.readFileSync(appJsSrcPath).toString();
        } catch (err) {
            rej(err);
        }
        appJsSrcContent = allRoutesStr + appJsSrcContent;
        rel({
            content: appJsSrcContent,
            dist: appJsDist
        });
    });
}
/**
 * 
 * @param {Array} queue 所有需要经过 merged 处理的文件
 * @return {String} 找到app.js的路径
 */
function getAppJsSourcePath( queue = []) {
    let appJsSourcePath = '';
    let appJsFileCount = queue.reduce(function(list, file){
        if (/\.js$/.test(file)) {
            list.push(file);
        }
        return list;
    }, []);

    if ( appJsFileCount.length > 1 ) {
        // eslint-disable-next-line
        console.error('整个项目中只能存在一个app.js\n',JSON.stringify(appJsFileCount, null, 4));
        process.exit(1);
    } else {
        appJsSourcePath = appJsFileCount[0];
    }
    return appJsSourcePath;
}

function getFilesMap(queue = []) {
    let map = {};
    let env = process.env.ANU_ENV;
    queue.forEach(function(file){
        if (/package\.json$/.test(file)) {
            let { dependencies = {}, devDependencies = {} } = require(file);
            if ( dependencies ) {
                map['pkgDependencies'] = map['pkgDependencies'] || [];
                map['pkgDependencies'].push({
                    id: file,
                    content: dependencies,
                    type: 'dependencies'
                });
            }
            if ( devDependencies ) {
                delete devDependencies['node-sass'];
                map['pkgDevDep'] = map['pkgDevDep'] || [];
                map['pkgDevDep'].push({
                    id: file,
                    content: devDependencies,
                    type: 'devDependencies'
                });
            }
            return;
        }
        if (/app\.json$/.test(file)) {
            var { alias={}, pages=[], order = 0 } = require(file);
           
            if (alias) {
                map['alias'] = map['alias'] || [];
                map['alias'].push({
                    id: file,
                    content: alias,
                    type: 'alias'
                });
            }
            
            if (pages.length) {
                let allInjectRoutes = pages.reduce(function(ret, route){
                    let injectRoute = '';
                    if ('[object Object]' === Object.prototype.toString.call(route)) {
                        // ' wx, ali,bu ,tt ' => ['wx', 'ali', 'bu', 'tt']
                        var supportPlat = route.platform.replace(/\s*/g, '').split(',');
                        if (supportPlat.includes(env)) {
                            injectRoute = route.route;
                        }
                    } else {
                        injectRoute = route;
                    }

                    if ( injectRoute ) {
                        ret.add(injectRoute);
                    }
                    return ret;
                }, new Set());

                map['pages'] = map['pages'] || [];
                map['pages'].push({
                    routes: Array.from(allInjectRoutes),
                    order: order
                }); 
            } 
            return;
        }
        
        var reg = new RegExp( env +'Config.json$');
        if (reg.test(file)) {
            try {
                var config = require(file);
                if (config) {
                    map['xconfig'] =  map['xconfig'] || [];
                    map['xconfig'].push({
                        id: file,
                        content: config
                    });
                }
            } catch (err) {
                // eslint-disable-next-line
            }
            
        }
        
    });
    map = orderRouteByOrder(map);
    return map;
}

function orderRouteByOrder(map) {
    //根据order排序
    map['pages'] = map['pages'].sort(function(a, b){
        //console.log(b, a);
        return b.order - a.order;
    });
    map['pages'] = map['pages'].map(function(pageEl){
        return pageEl.routes;
    });
    
    //二数组变一纬
    map['pages'] = [].concat(...map['pages']);
    return map;
}

function customizer(objValue, srcValue) {
    if ( Array.isArray(objValue)) {
        return Array.from(new Set(objValue.concat(srcValue)));
    }
}

function getMergedXConfigContent(config = {}) {
    let env = process.env.ANU_ENV;
    let xConfigJsonDist =  path.join(mergeDir, 'source', `${env}Config.json`);
    return Promise.resolve({
        dist: xConfigJsonDist,
        content: JSON.stringify(xDiff(config), null, 4)
    });
}

function getMergedData(configList){
    return xDiff(configList);
}

function getValueByPath(path, data){
    path = path.slice(0);
    var ret;
    while (path.length) {
        var key = path.shift();
        if (!ret) {
            ret = data[key] || '';
        } else {
            ret = ret[key] || '';
        }
    }
    return ret;
}

function xDiff(list) {
    if (!list) return {};
    let first = list[0];
    let confictQueue = [];
    let other = list.slice(1);
    let isConfict = false;
    for (let i = 0; i < other.length; i++) {
        let x = diff(first.content, other[i].content) || [];
        x = x.filter(function(el){
            return el.kind === 'E';
        });
        if (x.length) {
            isConfict = true;
            confictQueue = [...x];
            break;
        }
    }

    if (isConfict) {
        var errList = [];
        
        confictQueue.forEach(function(confictEl){
            //let keyName = confictEl.path[confictEl.path.length - 1];
            let kind = [];
            list.forEach(function(el){
                let confictValue =  getValueByPath(confictEl.path, el.content);
                if ( confictValue ) {
                    let errorItem = {};
                    errorItem.confictFile = el.id.replace(/\\/g, '/').split(/\/download\//).pop();
                    errorItem.confictValue = confictValue || '';
                    if (el.type === 'dependencies') {
                        errorItem.confictKeyPath = ['dependencies', ...confictEl.path];
                    } else if (el.type === 'devDependencies'){
                        errorItem.confictKeyPath = ['devDependencies', ...confictEl.path];
                    } else if (el.type === 'alias') {
                        errorItem.confictKeyPath = ['nanachi', 'alias', ...confictEl.path];
                    } else {
                        
                        errorItem.confictKeyPath = confictEl.path;
                    }
                    //console.log(errorItem);
                    errorItem.confictKeyPath = JSON.stringify(errorItem.confictKeyPath);
                    kind.push(errorItem);
                }
            });
            errList.push(kind);
        });

        var msg = '';
        
        errList.forEach(function(errEl){
            let kindErr = '';
            errEl.forEach(function(errItem){
                var tpl = `
冲突文件: ${(errItem.confictFile)}
冲突路径 ${errItem.confictKeyPath}
冲突值：${errItem.confictValue}
`;
                kindErr += tpl;
            });
            msg = msg + kindErr + '\n--------------------------------------------------\n';
        });
        
        // eslint-disable-next-line
        console.log(chalk.bold.red(msg));
        process.exit(1);
    }

    isConfict = false;

    if (!isConfict) {
        return list.reduce(function(ret, el){
            return merge(ret, el.content, customizer);
        }, {});
    } else {
        return {};
    }
}

function getMergedPkgJsonContent(alias) {
    let currentPkg = require(path.join(cwd, 'package.json'));
    let distContent = Object.assign(currentPkg, {
        nanachi: {
            alias: alias
        }
    });
    let dist = path.join(mergeDir, 'package.json');
    return {
        dist: dist,
        content: JSON.stringify(distContent, null, 4)
    };
}

module.exports = function(){
    let queue = Array.from(mergeFilesQueue);
    let map = getFilesMap(queue);
    
    let tasks = [
        //app.js路由注入
        getMergedAppJsConent( getAppJsSourcePath(queue), map.pages),
        //*Config.json合并
        getMergedXConfigContent(map.xconfig),
        //alias合并
        getMergedPkgJsonContent(getMergedData(map.alias))
    ];

    
    function getNodeModulesList(config) {
        let mergeData = getMergedData(config);
        
        return Object.keys(mergeData).reduce(function(ret, key){
            ret.push(key + '@' + mergeData[key]);
            return ret;
        }, []);
    }


    //['cookie@^0.3.1', 'regenerator-runtime@0.12.1']
    var installList = [...getNodeModulesList(map.pkgDependencies), ...getNodeModulesList(map.pkgDevDep)];
   
    //semver.satisfies('1.2.9', '~1.2.3')
    var installPkgList = installList.reduce(function(needInstall, pkg){
        //@xxx@1.0.0 => xxx
        var pkgName = pkg.replace(/^@/, '').split('@')[0];
        var isExit = fs.existsSync( path.join(cwd, 'node_modules', pkgName, 'package.json'));
        if (!isExit) {
            needInstall.push(pkg);
        } 
        return needInstall;
    }, []);


    //如果本地node_modules存在该模块，则不安装
    if (installPkgList.length) {
        //installPkgList = installPkgList.slice(0,2);
        let installList = installPkgList.join(' ');
        // --no-save 是为了不污染用户的package.json
        // eslint-disable-next-line
        console.log(chalk.bold.green(`npm 正在安装 ${installList}, 请稍等...`));
        let cmd = `npm install ${installList} --no-save`;
       
        // eslint-disable-next-line
        let std = shelljs.exec(cmd, {
            cwd: cwd,
            silent: true
        });
       
        if (/fatal:/.test(std.stderr)) {
            // eslint-disable-next-line
            console.log(chalk.red(std.stderr));
            process.exit(1);
        }
    }
    
    return Promise.all(tasks)
        .then(function(queue){
            queue = queue.map(function( {dist, content} ){
                return new Promise(function(rel, rej){
                    fs.ensureFileSync(dist);
                    fs.writeFile( dist, content, function(err){
                        if (err) {
                            rej(err);
                        } else {
                            rel(1);
                        }
                    });
                });
            });
            return Promise.all(queue);
        });
};