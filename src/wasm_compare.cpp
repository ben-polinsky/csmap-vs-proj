#include "compare_core.hpp"

#include <cctype>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

const char* skipSpace(const char* ptr) {
  while (*ptr != '\0' && std::isspace(static_cast<unsigned char>(*ptr))) ++ptr;
  return ptr;
}

const char* valueStart(const std::string& json, const std::string& key) {
  const std::string quoted = "\"" + key + "\"";
  const std::size_t keyPos = json.find(quoted);
  if (keyPos == std::string::npos) return nullptr;

  const std::size_t colon = json.find(':', keyPos + quoted.size());
  if (colon == std::string::npos) return nullptr;

  return skipSpace(json.c_str() + colon + 1);
}

std::string parseString(const std::string& json, const std::string& key, const std::string& fallback = "") {
  const char* ptr = valueStart(json, key);
  if (ptr == nullptr) return fallback;
  if (*ptr != '"') throw std::runtime_error(key + " must be a string");
  ++ptr;

  std::string value;
  while (*ptr != '\0') {
    if (*ptr == '"') return value;
    if (*ptr == '\\') {
      ++ptr;
      switch (*ptr) {
        case '"':
        case '\\':
        case '/':
          value.push_back(*ptr);
          break;
        case 'b':
          value.push_back('\b');
          break;
        case 'f':
          value.push_back('\f');
          break;
        case 'n':
          value.push_back('\n');
          break;
        case 'r':
          value.push_back('\r');
          break;
        case 't':
          value.push_back('\t');
          break;
        default:
          throw std::runtime_error("unsupported escape in " + key);
      }
    } else {
      value.push_back(*ptr);
    }
    ++ptr;
  }

  throw std::runtime_error("unterminated string for " + key);
}

std::string requiredString(const std::string& json, const std::string& key) {
  std::string value = parseString(json, key);
  if (value.empty()) throw std::runtime_error(key + " is required");
  return value;
}

double requiredNumber(const std::string& json, const std::string& key) {
  const char* ptr = valueStart(json, key);
  if (ptr == nullptr) throw std::runtime_error(key + " is required");

  char* end = nullptr;
  const double value = std::strtod(ptr, &end);
  if (end == ptr) throw std::runtime_error(key + " must be a number");
  return value;
}

csmap_proj::CompareOptions optionsFromJson(const char* requestJson) {
  if (requestJson == nullptr || *requestJson == '\0') {
    throw std::runtime_error("request JSON is empty");
  }

  const std::string json(requestJson);
  csmap_proj::CompareOptions options;
  options.csmapDict = parseString(json, "csmapDict", "/csmap");
  options.projDataPath = parseString(json, "projData", "/proj");
  options.csmapSource = requiredString(json, "sourceCsmap");
  options.csmapTarget = requiredString(json, "targetCsmap");
  options.projSource = requiredString(json, "sourceProj");
  options.projTarget = requiredString(json, "targetProj");
  options.x = requiredNumber(json, "x");
  options.y = requiredNumber(json, "y");
  return options;
}

char* copyResult(const std::string& value) {
  char* buffer = static_cast<char*>(std::malloc(value.size() + 1));
  if (buffer == nullptr) return nullptr;
  std::memcpy(buffer, value.c_str(), value.size() + 1);
  return buffer;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE char* compare_json(const char* requestJson) {
  try {
    return copyResult(csmap_proj::compareToJson(optionsFromJson(requestJson)));
  } catch (const std::exception& error) {
    return copyResult(csmap_proj::fatalJson(error.what()));
  }
}

EMSCRIPTEN_KEEPALIVE void free_result(char* result) {
  std::free(result);
}

}
